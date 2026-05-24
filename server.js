'use strict';
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer-core');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

app.use(express.json({ limit: '50mb' }));

// ============================================================
// PUPPETEER BROWSER POOL (persistente, single-process)
// ============================================================
let browserPromise = null;
async function getBrowser() {
    if (browserPromise) {
        try {
            const b = await browserPromise;
            if (b && b.isConnected()) return b;
        } catch (_) {}
        browserPromise = null;
    }
    browserPromise = puppeteer.launch({
        headless: 'new',
        executablePath: CHROMIUM_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
        ],
    }).catch((err) => {
        browserPromise = null;
        throw err;
    });
    return browserPromise;
}

// ============================================================
// HELPERS
// ============================================================

// CORS headers padrão para todos os endpoints de extração
function setCors(res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
}

// Registrar OPTIONS (preflight) para um path
function optionsHandler(path, app) {
    app.options(path, (req, res) => {
        setCors(res);
        res.sendStatus(200);
    });
}

// Extrai identidade_clinica do body com fallback seguro
function extrairIdentidade(body) {
    const id = body.identidade_clinica || {};
    return {
        profissional_nome:          id.profissional_nome          || '',
        profissional_conselho:      id.profissional_conselho      || '',
        profissional_especialidades: id.profissional_especialidades || '',
        clinica_nome:               id.clinica_nome               || ''
    };
}

// Parse robusto de JSON — remove fences de markdown se presentes
function parseJsonSafe(text) {
    const clean = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
    return JSON.parse(clean);
}

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '3.1-MC-pdf', timestamp: new Date().toISOString() });
});

// ============================================================
// GENERATE PDF (Puppeteer + Chromium)
// Recebe { html, landscape?, format? } -> devolve bytes PDF
// ============================================================
optionsHandler('/generate-pdf', app);
app.post('/generate-pdf', async (req, res) => {
    setCors(res);
    const { html, landscape = false, format = 'A4' } = req.body || {};
    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'html (string) eh obrigatorio' });
    }
    let page;
    const t0 = Date.now();
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
        // Puppeteer 23+ retorna Uint8Array; converte para Buffer para Express
        // serializar como binary (caso contrario fica JSON {"0":37,"1":80,...})
        const pdfBuffer = Buffer.from(await page.pdf({
            format,
            landscape,
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true,
        }));
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
        });
        res.send(pdfBuffer);
        console.log(`[generate-pdf] ok ${pdfBuffer.length}b ${Date.now() - t0}ms`);
    } catch (err) {
        console.error('[generate-pdf]', err.message);
        const fatal = /disconnected|closed|target closed|protocol error/i.test(err.message);
        if (fatal && browserPromise) {
            try { const b = await browserPromise; if (b) await b.close(); } catch (_) {}
            browserPromise = null;
        }
        res.status(500).json({ error: `Falha ao gerar PDF: ${err.message}` });
    } finally {
        if (page) { try { await page.close(); } catch (_) {} }
    }
});

// ============================================================
// PROXY DEEPGRAM
// ============================================================
optionsHandler('/proxy-deepgram', app);
app.post('/proxy-deepgram', upload.single('audio'), async (req, res) => {
    setCors(res);
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) return res.status(401).json({ error: 'Authorization header ausente' });
        if (!req.file)   return res.status(400).json({ error: 'Arquivo de audio ausente' });

        const queryString = new URLSearchParams(req.query).toString();
        const deepgramUrl = `https://api.deepgram.com/v1/listen?${queryString}`;
        const response = await fetch(deepgramUrl, {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': req.file.mimetype },
            body: req.file.buffer
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error('[proxy-deepgram] Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// PROXY CLAUDE API
// ============================================================
optionsHandler('/proxy-claude', app);
app.post('/proxy-claude', async (req, res) => {
    setCors(res);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        console.error('[proxy-claude] Erro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// PROXY UPLOAD LOGO (Google Drive via service account)
// ============================================================
optionsHandler('/proxy-upload-logo', app);
app.post('/proxy-upload-logo', async (req, res) => {
    setCors(res);
    // Repassa para o handler interno — mantido sem alteração funcional
    // Espera: { file_base64, file_name, mime_type, id_clinica }
    const { file_base64, file_name, mime_type, id_clinica } = req.body;
    if (!file_base64 || !file_name || !mime_type || !id_clinica) {
        return res.status(400).json({ error: 'Campos obrigatórios: file_base64, file_name, mime_type, id_clinica.' });
    }
    try {
        const { GoogleAuth } = require('google-auth-library');
        const { google } = require('googleapis');

        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
        const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
        const drive = google.drive({ version: 'v3', auth });

        const SHARED_DRIVE_ID = process.env.GOOGLE_SHARED_DRIVE_ID || '0AIyNCQeWe9-AUk9PVA';
        const buffer = Buffer.from(file_base64, 'base64');
        const { Readable } = require('stream');

        const driveRes = await drive.files.create({
            supportsAllDrives: true,
            requestBody: {
                name: file_name,
                parents: [SHARED_DRIVE_ID],
                driveId: SHARED_DRIVE_ID
            },
            media: { mimeType: mime_type, body: Readable.from(buffer) }
        });

        await drive.permissions.create({
            fileId: driveRes.data.id,
            supportsAllDrives: true,
            requestBody: { role: 'reader', type: 'anyone' }
        });

        const fileId = driveRes.data.id;
        const url = `https://drive.google.com/uc?export=view&id=${fileId}`;
        res.json({ sucesso: true, file_id: fileId, url });
    } catch (err) {
        console.error('[proxy-upload-logo] Erro:', err.message);
        res.status(500).json({ sucesso: false, error: err.message });
    }
});

// ============================================================
// PROXY MAKE.COM
// ============================================================
optionsHandler('/proxy-make', app);
app.post('/proxy-make', async (req, res) => {
    setCors(res);
    const { webhook_url, payload } = req.body;
    if (!webhook_url || !payload) {
        return res.status(400).json({ error: 'webhook_url e payload são obrigatórios.' });
    }
    try {
        const response = await fetch(webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        res.status(response.status).json(data);
    } catch (err) {
        console.error('[proxy-make] Erro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// EXTRACT BIOIMPEDANCE — D1 / S03
// Alteração 3.0: aceita identidade_clinica; remove hardcoding Dr. Mateus
// ============================================================
optionsHandler('/extract-bioimpedance', app);
app.post('/extract-bioimpedance', async (req, res) => {
    setCors(res);

    const { file_base64, file_type, equipamento_hint, identidade_clinica: _ } = req.body;
    const identidade = extrairIdentidade(req.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey)                      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
    if (!file_base64 || !file_type)   return res.status(400).json({ error: 'file_base64 e file_type são obrigatórios.' });

    const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const tiposDoc    = ['application/pdf'];
    if (![...tiposImagem, ...tiposDoc].includes(file_type)) {
        return res.status(400).json({ error: `Tipo não suportado: ${file_type}. Use PDF, JPEG, PNG, GIF ou WebP.` });
    }

    const anthropic = new Anthropic({ apiKey });

    const EXTRACTION_PROMPT = `Você está analisando um relatório de bioimpedanciometria.
Extraia todos os valores numéricos e retorne APENAS um objeto JSON válido, sem markdown, sem texto adicional, sem comentários.

Mapeie os dados para exatamente estes campos (retorne null se o campo não existir):
{
  "equipamento_detectado": "string com nome do equipamento identificado",
  "campos": {
    "bio_data": "string DD/MM/YYYY ou null",
    "bio_equipamento": "string ou null",
    "bio_peso_kg": "number ou null",
    "bio_altura_cm": "number ou null",
    "bio_imc": "number ou null",
    "bio_gordura_percentual": "number ou null",
    "bio_gordura_kg": "number ou null",
    "bio_massa_magra_kg": "number ou null",
    "bio_musculo_esqueletico_kg": "number ou null",
    "bio_musculo_esqueletico_percentual": "number ou null",
    "bio_agua_corporal_total_l": "number ou null",
    "bio_agua_corporal_percentual": "number ou null",
    "bio_agua_intracelular_l": "number ou null",
    "bio_agua_extracelular_l": "number ou null",
    "bio_razao_ece_aci": "number ou null",
    "bio_tmb_kcal": "number ou null",
    "bio_musculo_braco_d_kg": "number ou null",
    "bio_musculo_braco_e_kg": "number ou null",
    "bio_musculo_tronco_kg": "number ou null",
    "bio_musculo_perna_d_kg": "number ou null",
    "bio_musculo_perna_e_kg": "number ou null",
    "bio_gordura_braco_d_kg": "number ou null",
    "bio_gordura_braco_e_kg": "number ou null",
    "bio_gordura_tronco_kg": "number ou null",
    "bio_gordura_perna_d_kg": "number ou null",
    "bio_gordura_perna_e_kg": "number ou null",
    "bio_indice_gordura_visceral": "number ou null",
    "bio_grau_obesidade_percentual": "number ou null",
    "bio_smmi": "number ou null",
    "bio_fase_angulo": "number ou null"
  },
  "confianca": {
    "bio_data": "alta | media | baixa",
    "bio_equipamento": "alta | media | baixa",
    "bio_peso_kg": "alta | media | baixa",
    "bio_altura_cm": "alta | media | baixa",
    "bio_imc": "alta | media | baixa",
    "bio_gordura_percentual": "alta | media | baixa",
    "bio_gordura_kg": "alta | media | baixa",
    "bio_massa_magra_kg": "alta | media | baixa",
    "bio_musculo_esqueletico_kg": "alta | media | baixa",
    "bio_musculo_esqueletico_percentual": "alta | media | baixa",
    "bio_agua_corporal_total_l": "alta | media | baixa",
    "bio_agua_corporal_percentual": "alta | media | baixa",
    "bio_agua_intracelular_l": "alta | media | baixa",
    "bio_agua_extracelular_l": "alta | media | baixa",
    "bio_razao_ece_aci": "alta | media | baixa",
    "bio_tmb_kcal": "alta | media | baixa",
    "bio_musculo_braco_d_kg": "alta | media | baixa",
    "bio_musculo_braco_e_kg": "alta | media | baixa",
    "bio_musculo_tronco_kg": "alta | media | baixa",
    "bio_musculo_perna_d_kg": "alta | media | baixa",
    "bio_musculo_perna_e_kg": "alta | media | baixa",
    "bio_gordura_braco_d_kg": "alta | media | baixa",
    "bio_gordura_braco_e_kg": "alta | media | baixa",
    "bio_gordura_tronco_kg": "alta | media | baixa",
    "bio_gordura_perna_d_kg": "alta | media | baixa",
    "bio_gordura_perna_e_kg": "alta | media | baixa",
    "bio_indice_gordura_visceral": "alta | media | baixa",
    "bio_grau_obesidade_percentual": "alta | media | baixa",
    "bio_smmi": "alta | media | baixa",
    "bio_fase_angulo": "alta | media | baixa"
  },
  "campos_nao_encontrados": ["lista de campos ausentes no relatório"]
}

Regras:
- Retorne APENAS o JSON. Nenhum texto antes ou depois.
- Não invente valores. Se não encontrar, retorne null e marque confiança "baixa".
- Decimal com ponto (24.1, não 24,1). Datas DD/MM/YYYY.
- Confiança "alta" = valor claramente legível. "media" = possível variação de unidade. "baixa" = inferido, parcial, ausente ou null.
- Para InBody 370S: campos segmentares geralmente existem — marcar "alta" quando presentes.
- Equipamento hint fornecido: ${equipamento_hint || 'desconhecido'}`;

    const fileContentBlock = tiposDoc.includes(file_type)
        ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: file_type, data: file_base64 } };

    try {
        // 1ª chamada — extração estruturada
        const extractionMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            messages: [{ role: 'user', content: [fileContentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }]
        });

        let extractedData;
        try {
            extractedData = parseJsonSafe(extractionMsg.content[0].text);
        } catch (parseErr) {
            console.error('[extract-bioimpedance] JSON parse falhou:', extractionMsg.content[0].text.slice(0, 300));
            return res.status(500).json({ sucesso: false, error: 'Falha ao interpretar resposta da extração.', raw: extractionMsg.content[0].text.slice(0, 500) });
        }

        // 2ª chamada — comentário clínico D1C (multiclínica)
        const camposPreenchidos = Object.entries(extractedData.campos || {})
            .filter(([, v]) => v !== null)
            .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

        const profNome = identidade.profissional_nome || 'o médico responsável';
        const systemD1C = `Você é o motor de interpretação clínica da Plataforma AMA.
Escreva em primeira pessoa do singular, como ${profNome}.
Tom direto, técnico mas acessível ao paciente.
Máximo 4 frases.
Vá direto ao achado mais clinicamente relevante — nunca comece com introduções genéricas.
Proibido usar: robusto, crucial, abordagem, abrangente, holístico.
Nunca mencione nome de clínica ou CRM no texto gerado — esses dados são inseridos pelo sistema de formatação do laudo.`;

        const clinicalCommentMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: systemD1C,
            messages: [{
                role: 'user',
                content: `Com base nos dados de bioimpedanciometria abaixo, escreva o comentário clínico da composição corporal para a seção S03 do laudo AMA. Máximo 4 frases. Foco no achado mais relevante para a saúde metabólica deste paciente:\n\n${JSON.stringify(camposPreenchidos, null, 2)}`
            }]
        });

        res.json({
            sucesso: true,
            equipamento_detectado: extractedData.equipamento_detectado || 'Não identificado',
            campos: extractedData.campos || {},
            confianca: extractedData.confianca || {},
            comentario_clinico: clinicalCommentMsg.content[0].text,
            campos_nao_encontrados: extractedData.campos_nao_encontrados || []
        });

    } catch (error) {
        console.error('[extract-bioimpedance] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});

// ============================================================
// EXTRACT CALORIMETRY — D2 / S04  [NOVO — Tarefa 3.0]
// Aceita dados manuais de calorimetria indireta (TMR, QR, oxidação)
// Escala QR canônica de 7 faixas obrigatória
// ============================================================
optionsHandler('/extract-calorimetry', app);
app.post('/extract-calorimetry', async (req, res) => {
    setCors(res);

    const identidade = extrairIdentidade(req.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    // Campos de calorimetria indireta (todos opcionais com fallback seguro)
    const cal = req.body.dados_calorimetria || {};
    const paciente = req.body.paciente || {};
    const contexto = req.body.contexto_paciente || {};

    // Validação mínima: precisa de pelo menos TMR medida ou QR
    if (!cal.tmr_medida_kcal && !cal.qr_repouso) {
        return res.status(400).json({ error: 'Pelo menos tmr_medida_kcal ou qr_repouso deve ser fornecido.' });
    }

    const anthropic = new Anthropic({ apiKey });
    const profNome = identidade.profissional_nome || 'o médico responsável';

    const systemD2C = `Você é o motor de interpretação clínica da Plataforma AMA.
Escreva em primeira pessoa do singular, como ${profNome}.
Tom direto, técnico mas acessível ao paciente.
Máximo 5 frases.
Vá direto ao achado mais clinicamente relevante — nunca comece com introduções genéricas.
Proibido usar: robusto, crucial, abordagem, abrangente, holístico.
Nunca mencione nome de clínica ou CRM no texto gerado.

INTERPRETAÇÃO DO QR — ESCALA CANÔNICA OBRIGATÓRIA:
Use sempre a escala contextual de 7 faixas abaixo.
NUNCA interprete o QR de forma linear sem cruzar com o perfil clínico.

< 0,70     → Alerta crítico: problema técnico provável — exame requer repetição
0,70–0,74  → Possível com cetose/jejum > 18h; fora disso, registrar e aguardar validação
0,75–0,78  → Contextual: ativo + jejum protocolar = oxidação lipídica excelente | sedentário/SM/cetose possível = sinalizar
0,79–0,82  → Contextual: ativo + jejum = excelente | sedentário/SM/jejum prolongado = investigar cetose
0,83–0,85  → Zona de transição saudável — metabolismo equilibrado
0,85–0,90  → Dependência glicídica crescente. Em atleta de endurance: considerar overtraining metabólico.
0,90–1,00  → Dependência glicídica importante: excesso energético, inflamação ou overtraining — contextualizar com perfil
> 1,00     → Lipogênese ativa ou catabolismo agudo — registrar alerta

O comentário deve obrigatoriamente:
1. Citar o valor do QR e sua faixa interpretativa contextualizada
2. Informar o predomínio de oxidação (gordura vs carboidrato com valores em g/min e %VET)
3. Comparar TMR medido vs previsto com interpretação da diferença percentual
4. Conectar o QR ao estado mitocondrial do paciente de forma narrativa`;

    const userD2C = {
        identidade_clinica: identidade,
        paciente: {
            nome:                  paciente.nome                  || '',
            sexo:                  paciente.sexo                  || '',
            idade:                 paciente.idade                 || '',
            perfil_laudo:          contexto.perfil_laudo          || paciente.perfil_laudo || '',
            modalidade_esportiva:  contexto.modalidade_esportiva  || paciente.modalidade_esportiva || '',
            atividade_fisica_atual: contexto.atividade_fisica_atual || paciente.atividade_fisica_atual || ''
        },
        dados_calorimetria: {
            tmr_medida_kcal:                    cal.tmr_medida_kcal                    || null,
            tmr_estimada_kcal:                  cal.tmr_estimada_kcal                  || null,
            diferenca_percentual:               cal.diferenca_percentual               || null,
            qr_repouso:                         cal.qr_repouso                         || null,
            oxidacao_gordura_g_min:             cal.oxidacao_gordura_g_min             || null,
            oxidacao_gordura_percentual_vet:    cal.oxidacao_gordura_percentual_vet    || null,
            oxidacao_carbo_g_min:               cal.oxidacao_carbo_g_min               || null,
            oxidacao_carbo_percentual_vet:      cal.oxidacao_carbo_percentual_vet      || null,
            horas_jejum:                        cal.horas_jejum                        || null,
            condicoes_adequadas:                cal.condicoes_adequadas                || null
        },
        instrucao: 'Gere o comentário clínico da calorimetria indireta para a seção S04 do laudo AMA. Máximo 5 frases. Use obrigatoriamente a escala contextual de QR fornecida no system prompt.'
    };

    // Campos estruturados a retornar (passthrough dos dados recebidos)
    const camposCalorimetria = {
        cal_tmr_medida_kcal:                 cal.tmr_medida_kcal                 || null,
        cal_tmr_estimada_kcal:               cal.tmr_estimada_kcal               || null,
        cal_diferenca_percentual:            cal.diferenca_percentual            || null,
        cal_qr_repouso:                      cal.qr_repouso                      || null,
        cal_oxidacao_gordura_g_min:          cal.oxidacao_gordura_g_min          || null,
        cal_oxidacao_gordura_percentual_vet: cal.oxidacao_gordura_percentual_vet || null,
        cal_oxidacao_carbo_g_min:            cal.oxidacao_carbo_g_min            || null,
        cal_oxidacao_carbo_percentual_vet:   cal.oxidacao_carbo_percentual_vet   || null,
        cal_horas_jejum:                     cal.horas_jejum                     || null,
        cal_condicoes_adequadas:             cal.condicoes_adequadas             || null,
        cal_contexto_paciente:               contexto.perfil_laudo               || ''
    };

    try {
        const commentMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: systemD2C,
            messages: [{ role: 'user', content: JSON.stringify(userD2C) }]
        });

        res.json({
            sucesso: true,
            campos: camposCalorimetria,
            comentario_clinico: commentMsg.content[0].text
        });

    } catch (error) {
        console.error('[extract-calorimetry] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});

// ============================================================
// EXTRACT ERGOSPIROMETRY — D3 / S05
// Alteração 3.0: remove hardcoding; adiciona D3C (5 comentários S05–S09)
// ============================================================
optionsHandler('/extract-ergospirometry', app);
app.post('/extract-ergospirometry', async (req, res) => {
    setCors(res);

    const identidade = extrairIdentidade(req.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    const { file_base64, file_type } = req.body;
    if (!file_base64 || !file_type) {
        return res.status(400).json({ error: 'file_base64 e file_type são obrigatórios.' });
    }

    const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const tiposDoc    = ['application/pdf'];
    if (![...tiposImagem, ...tiposDoc].includes(file_type)) {
        return res.status(400).json({ error: `Tipo não suportado: ${file_type}.` });
    }

    const anthropic = new Anthropic({ apiKey });

    const EXTRACTION_PROMPT_ERGO = `Você está analisando um relatório de ergoespirometria (teste cardiopulmonar de exercício).
Extraia os valores e retorne APENAS um objeto JSON válido, sem markdown, sem texto adicional.

Campos obrigatórios (null se ausente):
{
  "ergo_data": "DD/MM/YYYY ou null",
  "ergo_protocolo": "string ou null",
  "ergo_equipamento": "string ou null",
  "ergo_modalidade": "esteira | cicloergometro | null",
  "l1_fc_bpm": "number ou null",
  "l1_vo2_ml_kg_min": "number ou null",
  "l1_velocidade_ou_potencia": "number ou null",
  "l1_percentual_vo2max": "number ou null",
  "l2_fc_bpm": "number ou null",
  "l2_vo2_ml_kg_min": "number ou null",
  "l2_velocidade_ou_potencia": "number ou null",
  "l2_percentual_vo2max": "number ou null",
  "crossover_fc_bpm": "number ou null",
  "crossover_velocidade_ou_potencia": "number ou null",
  "fatmax_fc_bpm": "number ou null",
  "fatmax_g_min": "number ou null",
  "fatmax_velocidade_ou_potencia": "number ou null",
  "vo2max_ml_kg_min": "number ou null",
  "fc_pico_bpm": "number ou null",
  "fc_maxima_prevista_bpm": "number ou null",
  "percentual_fcmax_atingida": "number ou null",
  "rer_pico": "number ou null",
  "ve_max_l_min": "number ou null",
  "mvv_percentual": "number ou null",
  "recuperacao_fc_1min_bpm": "number ou null",
  "recuperacao_fc_2min_bpm": "number ou null",
  "ve_vco2_l1": "number ou null",
  "ve_vo2_l1": "number ou null",
  "ve_vco2_l2": "number ou null",
  "ve_vo2_l2": "number ou null",
  "oscilacao_ventilatoria": "boolean ou null",
  "slope_ve_vco2": "number ou null"
}

Regras:
- Retorne APENAS o JSON. Sem texto antes ou depois.
- Decimal com ponto. Datas DD/MM/YYYY.
- Não invente valores. Ausente = null.
- Velocidade em km/h para esteira, Watts para cicloergometro.`;

    const fileContentBlock = tiposDoc.includes(file_type)
        ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: file_type, data: file_base64 } };

    try {
        // 1ª chamada — extração estruturada
        const extractionMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            messages: [{ role: 'user', content: [fileContentBlock, { type: 'text', text: EXTRACTION_PROMPT_ERGO }] }]
        });

        let extractedData;
        try {
            extractedData = parseJsonSafe(extractionMsg.content[0].text);
        } catch (parseErr) {
            console.error('[extract-ergospirometry] JSON parse falhou:', extractionMsg.content[0].text.slice(0, 300));
            return res.status(500).json({ sucesso: false, error: 'Falha ao interpretar resposta da extração.', raw: extractionMsg.content[0].text.slice(0, 500) });
        }

        // 2ª chamada — 5 comentários D3C (S05 a S09)
        const profNome = identidade.profissional_nome || 'o médico responsável';
        const paciente = req.body.paciente || {};
        const contexto = req.body.contexto_paciente || {};

        const systemD3C = `Você é o motor de interpretação clínica da Plataforma AMA, escrevendo como ${profNome}.
Primeira pessoa do singular. Tom técnico e preciso. Sem introduções genéricas.
Proibido: robusto, crucial, abordagem, abrangente, holístico.
Nunca mencione CRM ou nome de clínica no texto.`;

        const userD3C = `Dados de ergoespirometria:
${JSON.stringify(extractedData, null, 2)}

Paciente: ${paciente.nome || 'não informado'}, ${paciente.sexo || ''}, ${paciente.idade || ''} anos.
Perfil clínico: ${contexto.perfil_laudo || paciente.perfil_laudo || 'saúde'}.
Esporte: ${contexto.modalidade_esportiva || paciente.modalidade_esportiva || 'não informado'}.

Gere EXATAMENTE este JSON com 5 comentários clínicos (máximo 4 frases cada, sem markdown):
{
  "s05_comentario": "Seção Mapa Metabólico — comentário sobre L1, L2, VO2max e sua significância funcional para este paciente",
  "s06_comentario": "Seção Resposta Cardíaca — comentário sobre FC de repouso, comportamento durante esforço, recuperação e significado clínico",
  "s07_comentario": "Seção Equivalentes Ventilatórios — comentário sobre VE/VCO2, VE/VO2, slope e eficiência ventilatória",
  "s08_comentario": "Seção RER — comentário sobre QR de exercício, ponto de crossover e dependência glicídica vs lipídica",
  "s09_comentario": "Seção FATmax — comentário sobre pico de oxidação de gordura, zona FATmax e implicações para prescrição ou performance"
}

Retorne APENAS o JSON. Sem texto antes ou depois.`;

        const commentsMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            system: systemD3C,
            messages: [{ role: 'user', content: userD3C }]
        });

        let comentarios = {};
        try {
            comentarios = parseJsonSafe(commentsMsg.content[0].text);
        } catch (_) {
            console.warn('[extract-ergospirometry] comentarios parse falhou — retornando campos sem comentários');
        }

        res.json({
            sucesso: true,
            campos: extractedData,
            comentarios_d3c: {
                s05_comentario: comentarios.s05_comentario || '',
                s06_comentario: comentarios.s06_comentario || '',
                s07_comentario: comentarios.s07_comentario || '',
                s08_comentario: comentarios.s08_comentario || '',
                s09_comentario: comentarios.s09_comentario || ''
            }
        });

    } catch (error) {
        console.error('[extract-ergospirometry] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});

// ============================================================
// EXTRACT LABORATORIO — D4 / S10
// Alteração 3.0: remove hardcoding; adiciona D4C (flags visuais + narrativa S10)
// ============================================================
optionsHandler('/extract-laboratorio', app);
app.post('/extract-laboratorio', async (req, res) => {
    setCors(res);

    const identidade = extrairIdentidade(req.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    const { file_base64, file_type } = req.body;
    if (!file_base64 || !file_type) {
        return res.status(400).json({ error: 'file_base64 e file_type são obrigatórios.' });
    }

    const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const tiposDoc    = ['application/pdf'];
    if (![...tiposImagem, ...tiposDoc].includes(file_type)) {
        return res.status(400).json({ error: `Tipo não suportado: ${file_type}.` });
    }

    const anthropic = new Anthropic({ apiKey });

    const EXTRACTION_PROMPT_LAB = `Você está analisando resultados de exames laboratoriais.
Extraia os valores e retorne APENAS um objeto JSON válido, sem markdown.

Estrutura obrigatória:
{
  "lab_data": "DD/MM/YYYY ou null",
  "exames": [
    {
      "nome": "string — nome do exame",
      "valor": "number ou string — valor numérico ou resultado",
      "unidade": "string ou null",
      "referencia_min": "number ou null",
      "referencia_max": "number ou null",
      "flag": "normal | baixo | alto | critico | null"
    }
  ],
  "paineis_identificados": ["lista de painéis identificados: hemograma, lipidograma, glicemia, tireoide, hormonal, vitaminas, inflamacao, funcao_renal, funcao_hepatica, etc."]
}

Regras:
- Retorne APENAS o JSON.
- Para cada exame, determine o flag: "normal" dentro dos valores de referência; "baixo" abaixo; "alto" acima; "critico" fora de faixa com risco imediato.
- Se não há valores de referência no documento, use referências laboratoriais padrão brasileiras e marque flag com base nelas.
- Decimal com ponto. Datas DD/MM/YYYY.
- Inclua TODOS os exames visíveis no documento.`;

    const fileContentBlock = tiposDoc.includes(file_type)
        ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: file_type, data: file_base64 } };

    try {
        // 1ª chamada — extração estruturada
        const extractionMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 6000,
            messages: [{ role: 'user', content: [fileContentBlock, { type: 'text', text: EXTRACTION_PROMPT_LAB }] }]
        });

        let extractedData;
        try {
            extractedData = parseJsonSafe(extractionMsg.content[0].text);
        } catch (parseErr) {
            console.error('[extract-laboratorio] JSON parse falhou:', extractionMsg.content[0].text.slice(0, 300));
            return res.status(500).json({ sucesso: false, error: 'Falha ao interpretar resposta da extração.', raw: extractionMsg.content[0].text.slice(0, 500) });
        }

        // 2ª chamada — D4C: flags visuais consolidados + narrativa S10
        const profNome = identidade.profissional_nome || 'o médico responsável';
        const paciente = req.body.paciente || {};
        const contexto = req.body.contexto_paciente || {};

        const systemD4C = `Você é o motor de interpretação clínica da Plataforma AMA, escrevendo como ${profNome}.
Primeira pessoa do singular. Tom técnico mas acessível.
Máximo 5 frases para a narrativa S10.
Proibido: robusto, crucial, abordagem, abrangente, holístico.
Nunca mencione CRM ou nome de clínica.`;

        const examesAlterados = (extractedData.exames || [])
            .filter(e => e.flag && e.flag !== 'normal')
            .map(e => ({ nome: e.nome, valor: e.valor, unidade: e.unidade, flag: e.flag, referencia_min: e.referencia_min, referencia_max: e.referencia_max }));

        const examesNormais = (extractedData.exames || [])
            .filter(e => e.flag === 'normal')
            .map(e => e.nome);

        const userD4C = `Paciente: ${paciente.nome || 'não informado'}, ${paciente.sexo || ''}, ${paciente.idade || ''} anos.
Perfil: ${contexto.perfil_laudo || paciente.perfil_laudo || 'saúde'}.

Exames alterados: ${JSON.stringify(examesAlterados)}
Exames normais: ${examesNormais.join(', ')}

Gere este JSON (sem markdown):
{
  "s10_narrativa": "Narrativa clínica integrando os achados laboratoriais mais relevantes, priorizando exames alterados e sua relação com o perfil metabólico do paciente. Máximo 5 frases.",
  "flags_criticos": ["lista de nomes de exames com flag critico"],
  "flags_altos": ["lista de nomes de exames com flag alto"],
  "flags_baixos": ["lista de nomes de exames com flag baixo"],
  "resumo_paineis": "string resumindo os painéis avaliados e achados mais relevantes em 1-2 frases"
}`;

        const narrativaMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: systemD4C,
            messages: [{ role: 'user', content: userD4C }]
        });

        let d4c = {};
        try {
            d4c = parseJsonSafe(narrativaMsg.content[0].text);
        } catch (_) {
            console.warn('[extract-laboratorio] D4C parse falhou');
        }

        res.json({
            sucesso: true,
            lab_data: extractedData.lab_data || null,
            exames: extractedData.exames || [],
            paineis_identificados: extractedData.paineis_identificados || [],
            d4c: {
                s10_narrativa:  d4c.s10_narrativa  || '',
                flags_criticos: d4c.flags_criticos || [],
                flags_altos:    d4c.flags_altos    || [],
                flags_baixos:   d4c.flags_baixos   || [],
                resumo_paineis: d4c.resumo_paineis  || ''
            }
        });

    } catch (error) {
        console.error('[extract-laboratorio] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});

// ============================================================
// EXTRACT OUTROS EXAMES — D5 / S11
// Alteração 3.0: remove hardcoding; adiciona D5C (síntese por exame S11)
// ============================================================
optionsHandler('/extract-outros-exames', app);
app.post('/extract-outros-exames', async (req, res) => {
    setCors(res);

    const identidade = extrairIdentidade(req.body);
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    const { file_base64, file_type, tipo_exame } = req.body;
    if (!file_base64 || !file_type) {
        return res.status(400).json({ error: 'file_base64 e file_type são obrigatórios.' });
    }

    const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const tiposDoc    = ['application/pdf'];
    if (![...tiposImagem, ...tiposDoc].includes(file_type)) {
        return res.status(400).json({ error: `Tipo não suportado: ${file_type}.` });
    }

    const anthropic = new Anthropic({ apiKey });

    const EXTRACTION_PROMPT_OUTROS = `Você está analisando um exame complementar de saúde.
Tipo de exame informado: ${tipo_exame || 'não especificado'}.

Extraia os dados e retorne APENAS um objeto JSON válido:
{
  "tipo_exame_detectado": "string — tipo identificado no documento",
  "data_exame": "DD/MM/YYYY ou null",
  "laboratorio_clinica": "string ou null",
  "campos": {
    "descricao_livre": "string — resumo dos achados principais do exame em texto livre",
    "achados_relevantes": ["lista de achados relevantes identificados"],
    "conclusao_laudo": "string — conclusão ou laudo do exame se presente, ou null",
    "valores_quantitativos": [
      {
        "parametro": "string",
        "valor": "string ou number",
        "unidade": "string ou null",
        "referencia": "string ou null",
        "flag": "normal | alterado | null"
      }
    ]
  },
  "qualidade_documento": "boa | regular | ruim"
}`;

    const fileContentBlock = tiposDoc.includes(file_type)
        ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: file_type, data: file_base64 } };

    try {
        // 1ª chamada — extração estruturada
        const extractionMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 3000,
            messages: [{ role: 'user', content: [fileContentBlock, { type: 'text', text: EXTRACTION_PROMPT_OUTROS }] }]
        });

        let extractedData;
        try {
            extractedData = parseJsonSafe(extractionMsg.content[0].text);
        } catch (parseErr) {
            console.error('[extract-outros-exames] JSON parse falhou:', extractionMsg.content[0].text.slice(0, 300));
            return res.status(500).json({ sucesso: false, error: 'Falha ao interpretar resposta da extração.', raw: extractionMsg.content[0].text.slice(0, 500) });
        }

        // 2ª chamada — D5C: síntese clínica por exame S11
        const profNome = identidade.profissional_nome || 'o médico responsável';
        const paciente = req.body.paciente || {};
        const contexto = req.body.contexto_paciente || {};

        const systemD5C = `Você é o motor de interpretação clínica da Plataforma AMA, escrevendo como ${profNome}.
Primeira pessoa do singular. Tom técnico mas acessível.
Máximo 3 frases para a síntese.
Proibido: robusto, crucial, abordagem, abrangente, holístico.
Nunca mencione CRM ou nome de clínica.`;

        const userD5C = `Paciente: ${paciente.nome || 'não informado'}, ${paciente.sexo || ''}, ${paciente.idade || ''} anos.
Perfil: ${contexto.perfil_laudo || paciente.perfil_laudo || 'saúde'}.

Exame: ${extractedData.tipo_exame_detectado || tipo_exame || 'não especificado'}
Achados: ${JSON.stringify(extractedData.campos || {})}

Gere este JSON (sem markdown):
{
  "s11_sintese": "Síntese clínica deste exame para incluir na seção S11 do laudo AMA. Máximo 3 frases. Conecte o achado ao perfil metabólico e funcional do paciente."
}`;

        const sinteseMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 400,
            system: systemD5C,
            messages: [{ role: 'user', content: userD5C }]
        });

        let d5c = {};
        try {
            d5c = parseJsonSafe(sinteseMsg.content[0].text);
        } catch (_) {
            console.warn('[extract-outros-exames] D5C parse falhou');
        }

        res.json({
            sucesso: true,
            tipo_exame_detectado: extractedData.tipo_exame_detectado || tipo_exame || 'Não identificado',
            data_exame: extractedData.data_exame || null,
            laboratorio_clinica: extractedData.laboratorio_clinica || null,
            campos: extractedData.campos || {},
            qualidade_documento: extractedData.qualidade_documento || 'regular',
            d5c: {
                s11_sintese: d5c.s11_sintese || ''
            }
        });

    } catch (error) {
        console.error('[extract-outros-exames] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});

// ============================================================
// GENERATE DOCX — Pipeline principal
// Verificado 3.0: suporta identidade_clinica via body (passado ao gerar_laudo_AMA.js via dados.json)
// Sem alteração funcional — logo dinâmico gerenciado pelo gerar_laudo_AMA.js
// ============================================================
optionsHandler('/generate-docx', app);
app.post('/generate-docx', async (req, res) => {
    const jobId = uuidv4();
    const jobDir = '/tmp/ama-jobs/' + jobId;
    const graficosDir = jobDir + '/graficos';
    let jobCleanedUp = false;

    async function cleanup() {
        if (!jobCleanedUp) {
            jobCleanedUp = true;
            try { await fsp.rm(jobDir, { recursive: true, force: true }); } catch (_) {}
        }
    }

    const timeoutHandle = setTimeout(async () => {
        console.error('[generate-docx] Job ' + jobId + ' timeout');
        await cleanup();
        if (!res.headersSent) res.status(408).json({ error: 'Timeout: pipeline excedeu 55s' });
    }, 55000);

    // CORS
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });

    try {
        const body = req.body;
        if (!body || !body.paciente || !body.paciente.nome_completo) {
            clearTimeout(timeoutHandle);
            return res.status(400).json({ error: 'Campo obrigatório ausente', campo: 'paciente.nome_completo' });
        }
        if (!body.perfil_laudo) {
            clearTimeout(timeoutHandle);
            return res.status(400).json({ error: 'Campo obrigatório ausente', campo: 'perfil_laudo' });
        }
        if (!body.laudo_gerado) {
            clearTimeout(timeoutHandle);
            return res.status(400).json({ error: 'Campo obrigatório ausente', campo: 'laudo_gerado' });
        }

        await fsp.mkdir(graficosDir, { recursive: true });
        console.log('[generate-docx] Job ' + jobId + ' - ' + body.paciente.nome_completo);

        const dadosPath = jobDir + '/dados.json';
        await fsp.writeFile(dadosPath, JSON.stringify(body), 'utf8');

        // Gráficos
        const originalScript = await fsp.readFile('/app/gerar_graficos_AMA.py', 'utf8');
        const patchedScript = originalScript.split('/mnt/user-data/outputs/').join(graficosDir + '/');
        const scriptPath = jobDir + '/graficos_script.py';
        await fsp.writeFile(scriptPath, patchedScript, 'utf8');

        console.log('[generate-docx] Gerando gráficos...');
        try {
            const r1 = await execFileAsync('python3', [scriptPath, dadosPath], { timeout: 40000 });
            if (r1.stdout) console.log('[graficos] ' + r1.stdout);
            if (r1.stderr) console.error('[graficos stderr] ' + r1.stderr);
        } catch (err) {
            console.error('[generate-docx] Falha gráficos:', err.stderr || err.message);
            clearTimeout(timeoutHandle);
            await cleanup();
            return res.status(500).json({ error: 'Falha na geração de gráficos', detail: err.stderr || err.message });
        }

        // Logo: usa logo da clínica se disponível, senão logo Oxy Recovery como fallback
        const logoClinicaPath = jobDir + '/logo_clinica.jpg';
        const logoDefaultPath = '/app/Logo_Principal_Oxy_Recovery_Verde.jpg';
        let logoPath = logoDefaultPath;

        if (body.identidade_clinica && body.identidade_clinica.logo_url) {
            try {
                const logoResponse = await fetch(body.identidade_clinica.logo_url);
                if (logoResponse.ok) {
                    const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());
                    await fsp.writeFile(logoClinicaPath, logoBuffer);
                    logoPath = logoClinicaPath;
                    console.log('[generate-docx] Logo da clínica carregado: ' + body.identidade_clinica.logo_url);
                }
            } catch (logoErr) {
                console.warn('[generate-docx] Falha ao carregar logo da clínica, usando fallback:', logoErr.message);
            }
        }

        console.log('[generate-docx] Gerando laudo.docx...');
        const laudoDocxPath = jobDir + '/laudo.docx';
        try {
            const r2 = await execFileAsync('node', ['/app/gerar_laudo_AMA.js', dadosPath, laudoDocxPath, graficosDir, logoPath], { timeout: 40000 });
            if (r2.stdout) console.log('[laudo] ' + r2.stdout);
            if (r2.stderr) console.error('[laudo stderr] ' + r2.stderr);
        } catch (err) {
            console.error('[generate-docx] Falha laudo:', err.stderr || err.message);
            clearTimeout(timeoutHandle);
            await cleanup();
            return res.status(500).json({ error: 'Falha na geração do .docx', detail: err.stderr || err.message });
        }

        console.log('[generate-docx] Pós-processando...');
        const laudoFinalPath = jobDir + '/laudo_final.docx';
        try {
            const r3 = await execFileAsync('python3', ['/app/ama_docx_postprocess.py', laudoDocxPath, laudoFinalPath], { timeout: 20000 });
            if (r3.stdout) console.log('[postprocess] ' + r3.stdout);
            if (r3.stderr) console.error('[postprocess stderr] ' + r3.stderr);
        } catch (err) {
            console.error('[generate-docx] Falha postprocess:', err.stderr || err.message);
            clearTimeout(timeoutHandle);
            await cleanup();
            return res.status(500).json({ error: 'Falha no pós-processamento', detail: err.stderr || err.message });
        }

        const stat = await fsp.stat(laudoFinalPath);
        if (stat.size === 0) {
            clearTimeout(timeoutHandle);
            await cleanup();
            return res.status(500).json({ error: 'laudo_final.docx vazio' });
        }

        const nomeArquivo = 'Laudo_AMA_' + body.paciente.nome_completo.replace(/\s+/g, '_') + '_' + jobId.slice(0, 8) + '.docx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename="' + nomeArquivo + '"');

        const stream = fs.createReadStream(laudoFinalPath);
        stream.pipe(res);
        stream.on('end', async () => {
            clearTimeout(timeoutHandle);
            console.log('[generate-docx] Concluído - ' + nomeArquivo);
            await cleanup();
        });
        stream.on('error', async (err) => {
            clearTimeout(timeoutHandle);
            console.error('[generate-docx] Erro stream:', err.message);
            await cleanup();
        });

    } catch (err) {
        clearTimeout(timeoutHandle);
        console.error('[generate-docx] Erro não capturado ' + jobId + ':', err.stack || err.message);
        await cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// ============================================================
app.listen(PORT, () => {
    console.log('[AMA] server.js v3.0-MC — porta ' + PORT);
});

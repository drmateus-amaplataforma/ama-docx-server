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

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'T29B', timestamp: new Date().toISOString() });
});

// OPTIONS /proxy-deepgram (preflight CORS)
app.options('/proxy-deepgram', (req, res) => {
    res.set({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.sendStatus(200);
});

// POST /proxy-deepgram
app.post('/proxy-deepgram', upload.single('audio'), async (req, res) => {
    res.set({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    try {
          const authHeader = req.headers['authorization'];
          if (!authHeader) {
                  return res.status(401).json({ error: 'Authorization header ausente' });
          }
          if (!req.file) {
                  return res.status(400).json({ error: 'Arquivo de audio ausente' });
          }
          const queryString = new URLSearchParams(req.query).toString();
          const deepgramUrl = `https://api.deepgram.com/v1/listen?${queryString}`;
          const response = await fetch(deepgramUrl, {
                  method: 'POST',
                  headers: {
                            'Authorization': authHeader,
                            'Content-Type': req.file.mimetype
                  },
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
// PROXY CLAUDE API — T28E
// Variável de ambiente necessária: ANTHROPIC_API_KEY
// ============================================================
app.post('/proxy-claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }
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
// EXTRACT BIOIMPEDANCE — T29B
// ============================================================
app.options('/extract-bioimpedance', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.sendStatus(200);
});

app.post('/extract-bioimpedance', async (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });

    const { file_base64, file_type, equipamento_hint } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
    }
    if (!file_base64 || !file_type) {
        return res.status(400).json({ error: 'file_base64 e file_type são obrigatórios.' });
    }

    // FIX 1: Validar file_type suportado pela Claude API antes de prosseguir
    const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const tiposDoc    = ['application/pdf'];
    const tipoValido  = [...tiposImagem, ...tiposDoc].includes(file_type);
    if (!tipoValido) {
        return res.status(400).json({
            error: `Tipo de arquivo não suportado: ${file_type}. Use PDF, JPEG, PNG, GIF ou WebP.`
        });
    }

    const anthropic = new Anthropic({ apiKey });

    // FIX 2: Comentários JS dentro do template literal causariam JSON inválido
    // que a Claude poderia imitar. Removidos e substituídos por descrição clara em texto.
    const EXTRACTION_PROMPT = `Você está analisando um relatório de bioimpedanciometria. Extraia todos os valores numéricos e retorne APENAS um objeto JSON válido, sem markdown, sem texto adicional, sem comentários.

Mapeie os dados para exatamente estes campos (retorne null se o campo não existir no relatório):
{
  "equipamento_detectado": "string com nome do equipamento identificado",
  "campos": {
    "bio_data": "string no formato DD/MM/YYYY ou null",
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
  "campos_nao_encontrados": ["lista de nomes de campos não encontrados no relatório"]
}

Regras:
- Retorne APENAS o JSON. Nenhum texto antes ou depois.
- Não invente valores. Se não encontrar, retorne null e marque confiança como "baixa".
- Use ponto como separador decimal (não vírgula). Ex: 24.1 e não 24,1
- Datas no formato DD/MM/YYYY.
- Confiança "alta" = valor claramente legível e inequívoco.
- Confiança "media" = valor legível mas com possível variação de unidade ou formatação.
- Confiança "baixa" = valor inferido, parcialmente legível, ausente ou null.
- Para InBody 370S: os campos segmentares (braço D/E, tronco, perna D/E) geralmente existem e devem ter confiança "alta".
- Equipamento hint fornecido: ${equipamento_hint || 'desconhecido'}`;

    // FIX 3: Construção condicional do content block conforme tipo de arquivo
    // PDF deve usar type: 'document'; imagens usam type: 'image'
    const fileContentBlock = tiposDoc.includes(file_type)
        ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: file_type, data: file_base64 } };

    try {
        // Primeira chamada — extração de dados estruturados
        const extractionMsg = await anthropic.messages.create({
            // FIX 4: Atualizado para claude-sonnet-4-20250514 conforme padrão da plataforma AMA
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            messages: [{
                role: 'user',
                content: [
                    fileContentBlock,
                    { type: 'text', text: EXTRACTION_PROMPT }
                ]
            }]
        });

        // Parse robusto: remove possíveis backticks de markdown que o modelo possa emitir
        let rawText = extractionMsg.content[0].text.trim();
        rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
        let extractedData;
        try {
            extractedData = JSON.parse(rawText);
        } catch (parseErr) {
            console.error('[extract-bioimpedance] JSON parse falhou:', rawText.slice(0, 300));
            return res.status(500).json({
                sucesso: false,
                error: 'Falha ao interpretar resposta da extração. O arquivo pode não ser um relatório de bioimpedanciometria reconhecível.',
                raw: rawText.slice(0, 500)
            });
        }

        // Segunda chamada — comentário clínico
        // Filtra campos nulos para não poluir o prompt
        const camposPreenchidos = Object.entries(extractedData.campos || {})
            .filter(([, v]) => v !== null)
            .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

        const clinicalCommentMsg = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: 'Você é o Dr. Mateus Antunes Nogueira, médico do exercício e do esporte e nutrólogo, especialista em avaliação metabólica avançada e composição corporal. Escreva sempre em primeira pessoa do singular. Tom direto, técnico mas acessível — como médico explicando ao paciente. Máximo 4 frases. Vá direto ao achado mais clinicamente relevante — não use introduções genéricas como "Os dados mostram" ou "O paciente apresenta". Proibido usar as palavras: robusto, crucial, abordagem, comprehensive.',
            messages: [{
                role: 'user',
                content: `Com base nos dados de bioimpedanciometria abaixo, escreva um comentário clínico inicial sobre a composição corporal deste paciente. Identifique o achado mais relevante e oriente brevemente:\n\n${JSON.stringify(camposPreenchidos, null, 2)}`
            }]
        });

        const responsePayload = {
            sucesso: true,
            equipamento_detectado: extractedData.equipamento_detectado || 'Não identificado',
            campos: extractedData.campos || {},
            confianca: extractedData.confianca || {},
            comentario_clinico: clinicalCommentMsg.content[0].text,
            campos_nao_encontrados: extractedData.campos_nao_encontrados || []
        };

        res.json(responsePayload);

    } catch (error) {
        console.error('[extract-bioimpedance] Erro:', error);
        res.status(500).json({ sucesso: false, error: error.message });
    }
});


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
                 console.error('[T28B] Job ' + jobId + ' timeout');
                 await cleanup();
                 if (!res.headersSent) res.status(408).json({ error: 'Timeout: pipeline excedeu 55s' });
           }, 55000);

           try {
                 const body = req.body;
                 if (!body || !body.paciente || !body.paciente.nome_completo) {
                         clearTimeout(timeoutHandle);
                         return res.status(400).json({ error: 'Campo obrigatorio ausente', campo: 'paciente.nome_completo' });
                 }
                 if (!body.perfil_laudo) {
                         clearTimeout(timeoutHandle);
                         return res.status(400).json({ error: 'Campo obrigatorio ausente', campo: 'perfil_laudo' });
                 }
                 if (!body.laudo_gerado) {
                         clearTimeout(timeoutHandle);
                         return res.status(400).json({ error: 'Campo obrigatorio ausente', campo: 'laudo_gerado' });
                 }

      await fsp.mkdir(graficosDir, { recursive: true });
                 console.log('[T28B] Job ' + jobId + ' - ' + body.paciente.nome_completo);

      const dadosPath = jobDir + '/dados.json';
                 await fsp.writeFile(dadosPath, JSON.stringify(body), 'utf8');

      const originalScript = await fsp.readFile('/app/gerar_graficos_AMA.py', 'utf8');
                 const patchedScript = originalScript.split('/mnt/user-data/outputs/').join(graficosDir + '/');
                 const scriptPath = jobDir + '/graficos_script.py';
                 await fsp.writeFile(scriptPath, patchedScript, 'utf8');

      console.log('[T28B] Gerando graficos...');
                 try {
                         const r1 = await execFileAsync('python3', [scriptPath, dadosPath], { timeout: 40000 });
                         if (r1.stdout) console.log('[graficos] ' + r1.stdout);
                         if (r1.stderr) console.error('[graficos stderr] ' + r1.stderr);
                 } catch (err) {
                         console.error('[T28B] Falha graficos:', err.stderr || err.message);
                         clearTimeout(timeoutHandle);
                         await cleanup();
                         return res.status(500).json({ error: 'Falha na geracao de graficos', detail: err.stderr || err.message });
                 }

      console.log('[T28B] G1 G2 G3 G4 G5 OK');
                 const laudoDocxPath = jobDir + '/laudo.docx';
                 const logoPath = '/app/Logo_Principal_Oxy_Recovery_Verde.jpg';

      console.log('[T28B] Gerando laudo.docx...');
                 try {
                         const r2 = await execFileAsync('node', ['/app/gerar_laudo_AMA.js', dadosPath, laudoDocxPath, graficosDir, logoPath], { timeout: 40000 });
                         if (r2.stdout) console.log('[laudo] ' + r2.stdout);
                         if (r2.stderr) console.error('[laudo stderr] ' + r2.stderr);
                 } catch (err) {
                         console.error('[T28B] Falha laudo:', err.stderr || err.message);
                         clearTimeout(timeoutHandle);
                         await cleanup();
                         return res.status(500).json({ error: 'Falha na geracao do .docx', detail: err.stderr || err.message });
                 }

      console.log('[T28B] [AMA v2] Laudo gerado');
                 const laudoFinalPath = jobDir + '/laudo_final.docx';

      console.log('[T28B] Pos-processando...');
                 try {
                         const r3 = await execFileAsync('python3', ['/app/ama_docx_postprocess.py', laudoDocxPath, laudoFinalPath], { timeout: 20000 });
                         if (r3.stdout) console.log('[postprocess] ' + r3.stdout);
                         if (r3.stderr) console.error('[postprocess stderr] ' + r3.stderr);
                 } catch (err) {
                         console.error('[T28B] Falha postprocess:', err.stderr || err.message);
                         clearTimeout(timeoutHandle);
                         await cleanup();
                         return res.status(500).json({ error: 'Falha no pos-processamento', detail: err.stderr || err.message });
                 }

      console.log('[T28B] [postprocess] OK');
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
                         console.log('[T28B] Concluido - ' + nomeArquivo);
                         await cleanup();
                 });
                 stream.on('error', async (err) => {
                         clearTimeout(timeoutHandle);
                         console.error('[T28B] Erro stream:', err.message);
                         await cleanup();
                 });
           } catch (err) {
                 clearTimeout(timeoutHandle);
                 console.error('[T28B] Erro nao capturado ' + jobId + ':', err.stack || err.message);
                 await cleanup();
                 if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor' });
           }
});

// ============================================================
// PROXY UPLOAD LOGO — R04-B
// Recebe arquivo de imagem via multipart/form-data
// Salva no Google Drive na pasta AMA_Uploads/Clinicas/{id_clinica}/logo/
// Retorna URL pública do arquivo
// Variável de ambiente necessária: GOOGLE_SERVICE_ACCOUNT_JSON
// ============================================================

app.options('/proxy-upload-logo', function(req, res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.sendStatus(200);
});

app.post('/proxy-upload-logo', upload.single('logo'), async function(req, res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Arquivo de logo ausente' });
        }

        var idClinica = req.body.id_clinica || 'SEM_ID';

        // Validar tipo de arquivo
        var tiposPermitidos = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!tiposPermitidos.includes(req.file.mimetype)) {
            return res.status(400).json({ error: 'Tipo de arquivo nao permitido. Use JPG, PNG, GIF, WEBP ou SVG.' });
        }

        // Validar tamanho (max 5MB)
        if (req.file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'Arquivo muito grande. Maximo 5MB.' });
        }

        // Carregar service account
        var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!saJson) {
            return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON nao configurada no servidor' });
        }

        var sa;
        try {
            sa = JSON.parse(saJson);
        } catch (e) {
            return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON invalida: ' + e.message });
        }

        // Gerar JWT para autenticação com Google
        var jwt = await gerarJwtGoogle(sa);
        var accessToken = await obterAccessToken(jwt);

        // Buscar ou criar estrutura de pastas no Drive
        var pastaRaizId = await buscarOuCriarPasta(accessToken, 'AMA_Uploads', null);
        var pastaClinicasId = await buscarOuCriarPasta(accessToken, 'Clinicas', pastaRaizId);
        var pastaClinicaId = await buscarOuCriarPasta(accessToken, idClinica, pastaClinicasId);
        var pastaLogoId = await buscarOuCriarPasta(accessToken, 'logo', pastaClinicaId);

        // Fazer upload do arquivo
        var extensao = req.file.originalname.split('.').pop() || 'png';
        var nomeArquivo = 'logo_' + idClinica + '_' + Date.now() + '.' + extensao;

        var fileId = await uploadArquivoDrive(accessToken, req.file.buffer, req.file.mimetype, nomeArquivo, pastaLogoId);

        // Tornar público
        await tornarPublico(accessToken, fileId);

        // Retornar URL
        var url = 'https://drive.google.com/uc?export=view&id=' + fileId;

        res.json({
            sucesso: true,
            logo_url: url,
            file_id: fileId,
            nome: nomeArquivo
        });

    } catch (err) {
        console.error('[proxy-upload-logo] Erro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ID do Shared Drive AMA Platform Storage
var SHARED_DRIVE_ID = '0AIyNCQeWe9-AUk9PVA';

// ── Funções auxiliares Drive ──────────────────────────────────

async function gerarJwtGoogle(sa) {
    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var payload = Buffer.from(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    })).toString('base64url');

    var crypto = require('crypto');
    var sign = crypto.createSign('RSA-SHA256');
    sign.update(header + '.' + payload);
    var signature = sign.sign(sa.private_key, 'base64url');

    return header + '.' + payload + '.' + signature;
}

async function obterAccessToken(jwt) {
    var resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var data = await resp.json();
    if (!data.access_token) {
        throw new Error('Falha ao obter access token: ' + JSON.stringify(data));
    }
    return data.access_token;
}

async function buscarOuCriarPasta(token, nome, parentId) {
    // Buscar pasta existente no Shared Drive
    var query = "mimeType='application/vnd.google-apps.folder' and name='" + nome + "' and trashed=false";
    if (parentId) query += " and '" + parentId + "' in parents";

    var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) +
        '&fields=files(id,name)&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&driveId=' + SHARED_DRIVE_ID;

    var resp = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await resp.json();

    if (data.files && data.files.length > 0) {
        return data.files[0].id;
    }

    // Criar pasta no Shared Drive
    var meta = { name: nome, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) {
        meta.parents = [parentId];
    } else {
        meta.parents = [SHARED_DRIVE_ID];
    }

    var createResp = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(meta)
    });
    var created = await createResp.json();
    if (!created.id) throw new Error('Falha ao criar pasta ' + nome + ': ' + JSON.stringify(created));
    return created.id;
}

async function uploadArquivoDrive(token, buffer, mimetype, nome, parentId) {
    var meta = JSON.stringify({ name: nome, parents: [parentId] });
    var boundary = '-------AMAUploadBoundary';
    var delimiter = '\r\n--' + boundary + '\r\n';
    var closeDelimiter = '\r\n--' + boundary + '--';

    var metaPart = delimiter + 'Content-Type: application/json\r\n\r\n' + meta;
    var filePart = delimiter + 'Content-Type: ' + mimetype + '\r\n\r\n';
    var closepart = closeDelimiter;

    var metaBuffer = Buffer.from(metaPart);
    var filePartBuffer = Buffer.from(filePart);
    var closeBuffer = Buffer.from(closepart);
    var body = Buffer.concat([metaBuffer, filePartBuffer, buffer, closeBuffer]);

    var resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'multipart/related; boundary=' + boundary,
            'Content-Length': body.length
        },
        body: body
    });
    var data = await resp.json();
    if (!data.id) throw new Error('Falha no upload: ' + JSON.stringify(data));
    return data.id;
}

async function tornarPublico(token, fileId) {
    await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '/permissions', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
}



// ============================================================
// PROXY UPLOAD PROFISSIONAL — R05
// Recebe arquivo de imagem via multipart/form-data
// tipo: 'foto' | 'carteira' | 'logo'
// Salva no Google Drive em /AMA_Uploads/Profissionais/{id_profissional}/{tipo}/
// ============================================================

app.options('/proxy-upload-profissional', function(req, res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.sendStatus(200);
});

app.post('/proxy-upload-profissional', upload.single('arquivo'), async function(req, res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Arquivo ausente' });
        }

        var idProfissional = req.body.id_profissional || 'SEM_ID';
        var tipo = req.body.tipo || 'foto'; // foto | carteira | logo

        var tiposPermitidos = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'];
        if (!tiposPermitidos.includes(req.file.mimetype)) {
            return res.status(400).json({ error: 'Tipo de arquivo nao permitido.' });
        }

        if (req.file.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'Arquivo muito grande. Maximo 10MB.' });
        }

        var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!saJson) {
            return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON nao configurada' });
        }

        var sa;
        try { sa = JSON.parse(saJson); } catch (e) {
            return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON invalida' });
        }

        var jwt = await gerarJwtGoogle(sa);
        var accessToken = await obterAccessToken(jwt);

        var pastaRaizId = await buscarOuCriarPasta(accessToken, 'AMA_Uploads', null);
        var pastaProfissionaisId = await buscarOuCriarPasta(accessToken, 'Profissionais', pastaRaizId);
        var pastaProfId = await buscarOuCriarPasta(accessToken, idProfissional, pastaProfissionaisId);
        var pastaTipoId = await buscarOuCriarPasta(accessToken, tipo, pastaProfId);

        var extensao = req.file.originalname.split('.').pop() || 'jpg';
        var nomeArquivo = tipo + '_' + idProfissional + '_' + Date.now() + '.' + extensao;

        var fileId = await uploadArquivoDrive(accessToken, req.file.buffer, req.file.mimetype, nomeArquivo, pastaTipoId);
        await tornarPublico(accessToken, fileId);

        var url = 'https://drive.google.com/uc?export=view&id=' + fileId;

        res.json({ sucesso: true, url: url, file_id: fileId, nome: nomeArquivo, tipo: tipo });

    } catch (err) {
        console.error('[proxy-upload-profissional] Erro:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log('[T29B] AMA Docx Server porta ' + PORT + ' - T29B corrigido');
});

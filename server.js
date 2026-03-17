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
        rawText = rawText.replace(/^```(?:json)?s*/i, '').replace(/s*```s*$/i, '');

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
// EXTRACT CALORIMETRIA — D2
// ============================================================
app.options('/extract-calorimetria', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.sendStatus(200);
});

app.post('/extract-calorimetria', async (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });

  const { file_base64, file_type, equipamento_hint } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada no servidor.' });
  }

  if (!file_base64 || !file_type) {
    return res.status(400).json({ error: 'file_base64 e file_type sao obrigatorios.' });
  }

  const tiposImagem = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const tiposDoc = ['application/pdf'];
  const tipoValido = [...tiposImagem, ...tiposDoc].includes(file_type);

  if (!tipoValido) {
    return res.status(400).json({ error: 'Tipo de arquivo nao suportado: ' + file_type });
  }

  const anthropic = new Anthropic({ apiKey });

  const EXTRACTION_PROMPT = 'Voce e um extrator especializado em laudos de calorimetria indireta medica. Extraia todos os campos e retorne APENAS um JSON valido, sem texto adicional. Equipamento hint: ' + (equipamento_hint || 'desconhecido') + '. JSON esperado: {"sucesso":true,"campos":{"cal_data":null,"cal_equipamento":null,"cal_tmr_kcal":null,"cal_tmb_kcal":null,"cal_tmb_previsto_kcal":null,"cal_get_kcal":null,"cal_rq":null,"cal_gordura_percentual":null,"cal_carboidrato_percentual":null,"cal_vo2_ml_kg_min":null,"cal_ve_l_min":null,"cal_estilo_vida":null},"confianca":{"cal_data":"baixa","cal_equipamento":"baixa","cal_tmr_kcal":"baixa","cal_tmb_kcal":"baixa","cal_tmb_previsto_kcal":"baixa","cal_get_kcal":"baixa","cal_rq":"baixa","cal_gordura_percentual":"baixa","cal_carboidrato_percentual":"baixa","cal_vo2_ml_kg_min":"baixa","cal_ve_l_min":"baixa","cal_estilo_vida":"baixa"},"comentario_clinico":"resumo em 2-3 frases em portugues"}';

  const fileContentBlock = tiposDoc.includes(file_type)
    ? { type: 'document', source: { type: 'base64', media_type: file_type, data: file_base64 } }
    : { type: 'image', source: { type: 'base64', media_type: file_type, data: file_base64 } };

  try {
    const extractionMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          fileContentBlock,
          { type: 'text', text: EXTRACTION_PROMPT }
        ]
      }]
    });

    let rawText = extractionMsg.content[0].text.trim();
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

    let extractedData;
    try {
      extractedData = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('[extract-calorimetria] JSON parse falhou:', rawText.slice(0, 300));
      return res.status(500).json({ sucesso: false, error: 'Falha ao interpretar resposta.', raw: rawText.slice(0, 500) });
    }

    res.json({
      sucesso: true,
      campos: extractedData.campos || {},
      confianca: extractedData.confianca || {},
      comentario_clinico: extractedData.comentario_clinico || ''
    });

  } catch (error) {
    console.error('[extract-calorimetria] Erro:', error);
    res.status(500).json({ sucesso: false, error: error.message });
  }
});


// ============================================================
// ENDPOINT D3 — ERGOESPIROMETRIA + ZONAS DE TREINO
// ============================================================
app.options('/extract-ergoespirometria', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/extract-ergoespirometria', async (req, res) => {
  try {
    const { file_base64, file_type, equipamento_hint } = req.body;
    if (!file_base64) {
      return res.status(400).json({ sucesso: false, error: 'file_base64 obrigatorio' });
    }
    const isExcel = file_type && (
      file_type.includes('spreadsheet') ||
      file_type.includes('excel') ||
      file_type.includes('xlsx')
    );
    const resultado = isExcel
      ? await extrairErgoDoExcel(file_base64)
      : await extrairErgoDoPdf(file_base64, file_type, equipamento_hint);
    res.json(resultado);
  } catch (error) {
    console.error('Erro /extract-ergoespirometria:', error);
    res.status(500).json({ sucesso: false, error: error.message });
  }
});

async function extrairErgoDoExcel(file_base64) {
  const XLSX = require('xlsx');
  const buffer = Buffer.from(file_base64, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (!rows || rows.length === 0) {
    return { sucesso: false, error: 'Excel vazio ou formato nao reconhecido' };
  }
  const get = (row, ...keys) => {
    for (const k of keys) {
      const found = Object.keys(row).find(rk => rk.toLowerCase().includes(k.toLowerCase()));
      if (found !== undefined && row[found] !== null) return parseFloat(row[found]) || row[found];
    }
    return null;
  };
  const dadosBrutos = rows.map(row => ({
    estagio:        get(row, 'est', 'stage'),
    tempo_min:      get(row, 'tempo', 'time', 'min'),
    fc:             get(row, 'fc', 'hr', 'heart'),
    vo2_ml_kg_min:  get(row, 'vo2'),
    vco2:           get(row, 'vco2'),
    ve:             get(row, 've', 'vent'),
    rer:            get(row, 'rer', 'rq'),
    oxi_gord_g_min: get(row, 'oxi gord', 'fat', 'gord'),
    oxi_cho_g_min:  get(row, 'oxi cho', 'cho', 'carb'),
    perc_gord:      get(row, '% gord', '%gord', 'fat%'),
    perc_cho:       get(row, '% cho', '%cho', 'cho%'),
    vel_km_h:       get(row, 'vel', 'speed', 'km')
  })).filter(r => r.fc !== null);

  let fatmaxEstagio = null, fatmaxVal = -Infinity;
  dadosBrutos.forEach(r => {
    if (r.oxi_gord_g_min !== null && r.oxi_gord_g_min > fatmaxVal) {
      fatmaxVal = r.oxi_gord_g_min;
      fatmaxEstagio = r;
    }
  });

  const promptLimiares = `Analise estes dados de ergoespirometria estagio a estagio e identifique L1 (primeiro limiar ventilatorio) e L2 (segundo limiar ventilatorio). Retorne APENAS JSON valido:\n{"ergo_l1_fc":numero,"ergo_l1_vel_km_h":numero,"ergo_l2_fc":numero,"ergo_l2_vel_km_h":numero,"ergo_fc_repouso":numero,"ergo_fc_max":numero,"ergo_vo2max_ml_kg_min":numero,"ergo_protocolo":"texto ou null","ergo_equipamento":"HandyMet MDI","ergo_data":null}\nDados: ${JSON.stringify(dadosBrutos.slice(0, 30))}`;

  const respLimiares = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 800,
    messages: [{ role: 'user', content: promptLimiares }]
  });
  const campos = JSON.parse(respLimiares.content[0].text.trim().replace(/```json|```/g, '').trim());

  const l1 = campos.ergo_l1_fc, l2 = campos.ergo_l2_fc;
  const fcMax = campos.ergo_fc_max, fcRep = campos.ergo_fc_repouso;

  const promptComentario = `Voce e o Dr. Mateus Antunes Nogueira, especialista em medicina do exercicio. Escreva comentario clinico em 2-3 frases, primeira pessoa, tom tecnico direto. Va ao achado mais relevante. Proibido: robusto, crucial, abordagem.\nDados: L1=${l1}bpm, L2=${l2}bpm, VO2max=${campos.ergo_vo2max_ml_kg_min}ml/kg/min, FATmax=${fatmaxEstagio ? fatmaxEstagio.oxi_gord_g_min : null}g/min a ${fatmaxEstagio ? fatmaxEstagio.fc : null}bpm`;

  const respComentario = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 300,
    messages: [{ role: 'user', content: promptComentario }]
  });

  return {
    sucesso: true,
    campos: {
      ...campos,
      ergo_fatmax_fc: fatmaxEstagio ? fatmaxEstagio.fc : null,
      ergo_fatmax_vel_km_h: fatmaxEstagio ? fatmaxEstagio.vel_km_h : null,
      ergo_fatmax_g_min: fatmaxEstagio ? fatmaxEstagio.oxi_gord_g_min : null,
      zona_1_fc_min: fcRep, zona_1_fc_max: Math.round(l1 * 0.85),
      zona_2_fc_min: Math.round(l1 * 0.85), zona_2_fc_max: l1,
      zona_3_fc_min: l1, zona_3_fc_max: Math.round((l1 + l2) / 2),
      zona_4_fc_min: Math.round((l1 + l2) / 2), zona_4_fc_max: l2,
      zona_5_fc_min: l2, zona_5_fc_max: fcMax
    },
    confianca: Object.fromEntries(
      ['ergo_data','ergo_equipamento','ergo_protocolo','ergo_fc_repouso','ergo_fc_max',
       'ergo_vo2max_ml_kg_min','ergo_l1_fc','ergo_l1_vel_km_h','ergo_l2_fc','ergo_l2_vel_km_h',
       'ergo_fatmax_fc','ergo_fatmax_vel_km_h','ergo_fatmax_g_min',
       'zona_1_fc_min','zona_1_fc_max','zona_2_fc_min','zona_2_fc_max',
       'zona_3_fc_min','zona_3_fc_max','zona_4_fc_min','zona_4_fc_max',
       'zona_5_fc_min','zona_5_fc_max'].map(k => [k, 'alta'])
    ),
    ergo_dados_brutos: dadosBrutos,
    comentario_clinico: respComentario.content[0].text.trim()
  };
}

async function extrairErgoDoPdf(file_base64, file_type, equipamento_hint) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5', max_tokens: 3000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: file_type || 'application/pdf', data: file_base64 } },
      { type: 'text', text: `Extrator de ergoespirometria. Retorne APENAS JSON:\n{"sucesso":true,"campos":{"ergo_data":"DD/MM/AAAA ou null","ergo_equipamento":"nome ou null","ergo_protocolo":"texto ou null","ergo_fc_repouso":numero,"ergo_fc_max":numero,"ergo_vo2max_ml_kg_min":numero,"ergo_l1_fc":numero,"ergo_l1_vel_km_h":numero,"ergo_l2_fc":numero,"ergo_l2_vel_km_h":numero,"ergo_fatmax_fc":numero,"ergo_fatmax_vel_km_h":numero,"ergo_fatmax_g_min":numero,"zona_1_fc_min":numero,"zona_1_fc_max":numero,"zona_2_fc_min":numero,"zona_2_fc_max":numero,"zona_3_fc_min":numero,"zona_3_fc_max":numero,"zona_4_fc_min":numero,"zona_4_fc_max":numero,"zona_5_fc_min":numero,"zona_5_fc_max":numero},"confianca":{},"ergo_dados_brutos":[],"comentario_clinico":"2-3 frases em portugues, primeira pessoa."}\nEquipamento: ${equipamento_hint || 'HandyMet MDI'}` }
    ]}]
  });
  return JSON.parse(response.content[0].text.trim().replace(/```json|```/g, '').trim());
}
app.listen(PORT, () => {
    console.log('[T29B] AMA Docx Server porta ' + PORT + ' - T29B corrigido');
});

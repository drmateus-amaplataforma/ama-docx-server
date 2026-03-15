'use strict';
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'T28B', timestamp: new Date().toISOString() });
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

app.listen(PORT, () => {
    console.log('[T28B] AMA Docx Server porta ' + PORT + ' - T28B');
});

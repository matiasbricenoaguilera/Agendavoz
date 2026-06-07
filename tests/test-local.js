/**
 * Script de prueba local para la Netlify Function `telegram-bot`.
 *
 * Prerrequisitos:
 *   1. Tener el archivo .env configurado con todas las variables.
 *   2. Tener `netlify-cli` instalado: npm install (o npm i -g netlify-cli).
 *   3. Tener el servidor local corriendo: npm run dev  (en otra terminal).
 *
 * Uso:
 *   # Probar con mensaje de texto (/start) — no requiere Telegram real
 *   npm run test:local
 *
 *   # Probar NLU de Gemini directamente con una frase (sin audio)
 *   node --env-file=.env tests/test-local.js --phrase "Agendar dentista el martes a las 3 de la tarde"
 *
 *   # Probar con archivo de audio .ogg real
 *   node --env-file=.env tests/test-local.js --audio tests/sample.ogg
 *
 *   # Probar con payload de voz mock (requiere file_id válido en mock-payload.json)
 *   node --env-file=.env tests/test-local.js --voice
 *
 * Alternativa curl (sin necesidad de este script):
 *   curl -X POST http://localhost:8888/.netlify/functions/telegram-bot \
 *     -H "Content-Type: application/json" \
 *     -d @tests/mock-text-payload.json
 */

import axios            from 'axios';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FUNCTION_URL = 'http://localhost:8888/.netlify/functions/telegram-bot';
const args         = process.argv.slice(2);

// ─── Modo: prueba rápida de NLU de Gemini (sin llamadas a Telegram) ──────────

async function testGeminiNLU(phrase) {
  console.log('\n🧠 Probando extracción NLU de Gemini directamente...\n');
  console.log(`Frase: "${phrase}"\n`);

  const { extractEventDetails } = await import('../src/services/gemini.js');

  try {
    const details = await extractEventDetails(phrase);
    console.log('✅ Resultado del NLU:\n', JSON.stringify(details, null, 2));
  } catch (err) {
    console.error('❌ Error en Gemini NLU:', err.message);
  }
}

// ─── Modo: prueba de audio .ogg local con Gemini STT ────────────────────────

async function testAudioFile(audioPath) {
  console.log(`\n🎙️ Probando transcripción de audio: ${audioPath}\n`);

  const { transcribeAudio }    = await import('../src/services/gemini.js');
  const { extractEventDetails} = await import('../src/services/gemini.js');

  try {
    const buffer = readFileSync(resolve(audioPath));
    const mimeType = audioPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg';

    console.log(`Archivo: ${buffer.length} bytes, MIME: ${mimeType}\n`);

    const transcription = await transcribeAudio(buffer, mimeType);
    console.log(`📝 Transcripción: "${transcription}"\n`);

    const details = await extractEventDetails(transcription);
    console.log('📅 Detalles del evento:\n', JSON.stringify(details, null, 2));
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// ─── Modo: enviar payload mock al servidor local de Netlify ─────────────────

async function sendMockPayload(payloadFile) {
  const payloadPath = resolve(__dirname, payloadFile);
  const rawPayload  = readFileSync(payloadPath, 'utf-8');

  // Eliminar comentarios del JSON antes de parsear
  const payload = JSON.parse(rawPayload.replace(/"_comment":[^,}]+,?/g, ''));

  console.log(`\n📤 Enviando payload a: ${FUNCTION_URL}`);
  console.log('📦 Payload:\n', JSON.stringify(payload, null, 2), '\n');

  try {
    const response = await axios.post(FUNCTION_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    console.log(`✅ HTTP ${response.status} — Respuesta:`, response.data);
  } catch (err) {
    if (err.response) {
      console.error(`❌ HTTP ${err.response.status}:`, err.response.data);
    } else if (err.code === 'ECONNREFUSED') {
      console.error('❌ No se pudo conectar al servidor local.');
      console.error('   ¿Está corriendo `npm run dev` en otra terminal?');
    } else {
      console.error('❌ Error:', err.message);
    }
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  Agenda por Voz — Prueba Local');
  console.log('══════════════════════════════════════════');

  const phraseIdx = args.indexOf('--phrase');
  const audioIdx  = args.indexOf('--audio');

  if (phraseIdx !== -1 && args[phraseIdx + 1]) {
    await testGeminiNLU(args[phraseIdx + 1]);
  } else if (audioIdx !== -1 && args[audioIdx + 1]) {
    await testAudioFile(args[audioIdx + 1]);
  } else if (args.includes('--voice')) {
    await sendMockPayload('mock-payload.json');
  } else {
    // Default: probar con payload de texto (/start)
    await sendMockPayload('mock-text-payload.json');
  }
}

main();

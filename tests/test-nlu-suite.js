/**
 * Suite de regresión para `extractEventDetails` (NLU).
 *
 * Ejecuta cada caso de `nlu-cases.js` contra la API real de OpenAI y valida
 * los campos esperados. Hace llamadas reales (consume cuota de OPENAI_API_KEY).
 *
 * Uso:
 *   npm run test:nlu
 */

import { extractEventDetails } from '../src/services/gemini.js';
import { nluCases } from './nlu-cases.js';

/** Extrae la hora (0-23) de un ISO string "...THH:MM:SS±HH:MM". */
function hourFromISO(isoString) {
  if (!isoString) return null;
  return parseInt(isoString.slice(11, 13), 10);
}

function checkCase({ name, phrase, expect: exp }) {
  return extractEventDetails(phrase).then((details) => {
    const failures = [];

    if (exp.intent !== undefined && details.intent !== exp.intent) {
      failures.push(`intent: esperado "${exp.intent}", obtenido "${details.intent}"`);
    }
    if (exp.category !== undefined && details.category !== exp.category) {
      failures.push(`category: esperado "${exp.category}", obtenido "${details.category}"`);
    }
    if (exp.date_specified !== undefined && details.date_specified !== exp.date_specified) {
      failures.push(`date_specified: esperado ${exp.date_specified}, obtenido ${details.date_specified}`);
    }
    if (exp.time_specified !== undefined && details.time_specified !== exp.time_specified) {
      failures.push(`time_specified: esperado ${exp.time_specified}, obtenido ${details.time_specified}`);
    }
    if (exp.hour !== undefined && exp.time_specified !== false) {
      const isoToCheck = details.intent === 'mover' ? details.new_start_time : details.start_time;
      const hour = hourFromISO(isoToCheck);
      if (hour !== exp.hour) {
        failures.push(`hour: esperado ${exp.hour}, obtenido ${hour}`);
      }
    }
    if (exp.hasNotes && !(typeof details.notes === 'string' && details.notes.length > 0)) {
      failures.push(`hasNotes: esperado notes no vacío, obtenido "${details.notes}"`);
    }
    if (exp.hasNewSummary && details.new_summary == null) {
      failures.push(`hasNewSummary: esperado new_summary no nulo, obtenido ${details.new_summary}`);
    }
    if (exp.additionalEventsCount !== undefined) {
      const count = Array.isArray(details.additional_events) ? details.additional_events.length : 0;
      if (count !== exp.additionalEventsCount) {
        failures.push(`additionalEventsCount: esperado ${exp.additionalEventsCount}, obtenido ${count}`);
      }
    }

    return { name, phrase, details, failures };
  }).catch((err) => ({ name, phrase, details: null, failures: [`error: ${err.message}`] }));
}

async function main() {
  console.log(`\n🧪 Ejecutando suite de NLU (${nluCases.length} casos)...\n`);

  let passed = 0;
  let failed = 0;

  for (const testCase of nluCases) {
    const result = await checkCase(testCase);

    if (result.failures.length === 0) {
      passed++;
      console.log(`✅ ${result.name}`);
    } else {
      failed++;
      console.log(`❌ ${result.name}`);
      console.log(`   Frase: "${result.phrase}"`);
      for (const f of result.failures) console.log(`   - ${f}`);
      if (result.details) console.log(`   Respuesta: ${JSON.stringify(result.details)}`);
    }
  }

  console.log(`\n${passed} pasaron, ${failed} fallaron de ${nluCases.length} casos.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

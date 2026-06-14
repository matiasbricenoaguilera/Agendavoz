/**
 * Casos de prueba para `extractEventDetails` (NLU).
 *
 * Cada caso define la frase de entrada y las expectativas MÍNIMAS que debe
 * cumplir el JSON devuelto. No se valida el objeto completo, solo los campos
 * listados en `expect` (más permisivo ante variaciones menores del LLM).
 *
 * Campos soportados en `expect`:
 *   - intent, category: igualdad exacta
 *   - date_specified, time_specified: igualdad exacta
 *   - hour: hora (0-23) extraída de start_time o new_start_time (la que aplique
 *     según el intent), comparada solo si time_specified es true
 *   - hasNotes: boolean, si `notes` debe ser un string no vacío
 *   - hasNewSummary: boolean, si `new_summary` debe ser distinto de null
 *   - additionalEventsCount: largo exacto de `additional_events`
 */

export const nluCases = [
  {
    name: 'agendar con día y hora explícitos (salud)',
    phrase: 'Agendar dentista el martes a las 3 de la tarde',
    expect: { intent: 'agendar', category: 'salud', date_specified: true, time_specified: true, hour: 15 },
  },
  {
    name: 'agendar con día y hora explícitos (trabajo)',
    phrase: 'Reunión de trabajo con el equipo el lunes a las 9 de la mañana',
    expect: { intent: 'agendar', category: 'trabajo', date_specified: true, time_specified: true, hour: 9 },
  },
  {
    name: 'agendar sin hora explícita (salud)',
    phrase: 'Agenda ir al gimnasio mañana',
    expect: { intent: 'agendar', category: 'salud', date_specified: true, time_specified: false },
  },
  {
    name: 'consultar el día de hoy',
    phrase: '¿Qué tengo agendado para hoy?',
    expect: { intent: 'consultar', date_specified: true },
  },
  {
    name: 'cancelar evento con día especificado',
    phrase: 'Cancela la reunión del jueves',
    expect: { intent: 'cancelar', date_specified: true },
  },
  {
    name: 'mover evento a nueva fecha y hora',
    phrase: 'Mueve mi cita al dentista del martes para el miércoles a las 4 de la tarde',
    expect: { intent: 'mover', date_specified: true, time_specified: true, hour: 16 },
  },
  {
    name: 'anotar agrega una nota',
    phrase: 'Agrega una nota a la reunión de mañana: traer el informe actualizado',
    expect: { intent: 'anotar', hasNotes: true },
  },
  {
    name: 'editar cambia el título',
    phrase: "Cambia el título de la reunión del lunes a 'Reunión con cliente'",
    expect: { intent: 'editar', hasNewSummary: true },
  },
  {
    name: 'agendar evento social con hora explícita',
    phrase: 'Junta de cumpleaños de Ana el sábado a las 8 de la noche',
    expect: { intent: 'agendar', category: 'social', date_specified: true, time_specified: true, hour: 20 },
  },
  {
    name: 'agendar evento de estudio con hora explícita',
    phrase: 'Tengo certamen de cálculo el viernes a las 10',
    expect: { intent: 'agendar', category: 'estudio', date_specified: true, time_specified: true, hour: 10 },
  },
  {
    name: 'agendar trámite personal sin hora explícita',
    phrase: 'Trámite en el banco el lunes',
    expect: { intent: 'agendar', category: 'personal', date_specified: true, time_specified: false },
  },
  {
    name: 'agendar múltiples eventos en un mensaje',
    phrase: 'Agenda dentista el lunes a las 10 y reunión el martes a las 4',
    expect: { intent: 'agendar', additionalEventsCount: 1 },
  },
];

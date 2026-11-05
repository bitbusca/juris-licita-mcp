/** Data e hora de Brasília (as fontes públicas brasileiras usam horário local sem fuso). */
export function agoraBrasilia(d: Date = new Date()): { dia: string; mes: string; ano: number; isoLocal: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const dia = `${p.year}-${p.month}-${p.day}`;
  return { dia, mes: dia.slice(0, 7), ano: Number(p.year), isoLocal: `${dia}T${p.hour}:${p.minute}` };
}

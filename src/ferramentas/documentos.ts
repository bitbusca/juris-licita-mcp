/**
 * Validação de CPF e CNPJ pelo dígito verificador, 100% local: nenhum número sai da máquina e
 * nenhuma base é consultada. Validar o dígito NÃO diz se o documento existe nem de quem é.
 *
 * CNPJ alfanumérico (IN RFB 2.229/2024, novos CNPJs a partir de julho de 2026): as 12 primeiras
 * posições aceitam 0-9 e A-Z; cada caractere vale (código ASCII − 48) e os dois dígitos
 * verificadores continuam numéricos, com o mesmo módulo 11. O CNPJ só de números é o caso
 * particular em que o valor é o próprio dígito.
 */

export type TipoDocumento = 'cpf' | 'cnpj';

export interface ResultadoValidacao {
  tipo: TipoDocumento | 'desconhecido';
  valido: boolean;
  /** CNPJ formatado (00.000.000/0000-00). CPF nunca volta inteiro: só mascarado. */
  formatado?: string;
  mascarado?: string;
  motivo?: string;
  detalhes?: Record<string, string | boolean>;
  aviso: string;
}

const AVISO =
  'Validação matemática local (dígito verificador). Não consulta nenhuma base: não diz se o documento existe, a quem pertence nem a situação cadastral.';

/** Tira pontuação e espaços; letras viram maiúsculas (CNPJ alfanumérico). */
export function limparDocumento(s: string): string {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[\s.\-/]/g, '');
}

function dvModulo11(valores: number[], pesos: number[]): number {
  const soma = valores.reduce((acc, v, i) => acc + v * pesos[i], 0);
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Região fiscal de emissão do CPF (9º dígito). É do número, não da pessoa. */
const REGIAO_FISCAL: Record<string, string> = {
  '0': 'RS',
  '1': 'DF, GO, MS, MT e TO',
  '2': 'AC, AM, AP, PA, RO e RR',
  '3': 'CE, MA e PI',
  '4': 'AL, PB, PE e RN',
  '5': 'BA e SE',
  '6': 'MG',
  '7': 'ES e RJ',
  '8': 'SP',
  '9': 'PR e SC',
};

export function validarCpf(entrada: string): ResultadoValidacao {
  const d = limparDocumento(entrada);
  const base = { tipo: 'cpf' as const, aviso: AVISO };
  if (!/^\d{11}$/.test(d)) return { ...base, valido: false, motivo: 'O CPF tem 11 dígitos numéricos.' };
  if (/^(\d)\1{10}$/.test(d)) return { ...base, valido: false, motivo: 'Sequência de dígitos repetidos não é CPF válido.' };
  const n = d.split('').map(Number);
  const dv1 = dvModulo11(n.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = dvModulo11(n.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const mascarado = `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (dv1 !== n[9] || dv2 !== n[10]) return { ...base, valido: false, mascarado, motivo: 'Dígito verificador não confere.' };
  return { ...base, valido: true, mascarado, detalhes: { regiaoFiscalDeEmissao: REGIAO_FISCAL[d[8]] } };
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const valorCaractere = (c: string) => c.charCodeAt(0) - 48;

/** Os dois dígitos verificadores de uma base de 12 posições (numérica ou alfanumérica). */
export function dvCnpj(base12: string): string {
  const v = limparDocumento(base12).split('').map(valorCaractere);
  const dv1 = dvModulo11(v, PESOS_CNPJ_1);
  const dv2 = dvModulo11([...v, dv1], PESOS_CNPJ_2);
  return `${dv1}${dv2}`;
}

export function formatarCnpj(d14: string): string {
  return `${d14.slice(0, 2)}.${d14.slice(2, 5)}.${d14.slice(5, 8)}/${d14.slice(8, 12)}-${d14.slice(12, 14)}`;
}

export function validarCnpj(entrada: string): ResultadoValidacao {
  const d = limparDocumento(entrada);
  const base = { tipo: 'cnpj' as const, aviso: AVISO };
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d)) {
    return { ...base, valido: false, motivo: 'O CNPJ tem 14 posições: 12 números ou letras (A-Z) e 2 dígitos verificadores numéricos.' };
  }
  if (/^(.)\1{13}$/.test(d)) return { ...base, valido: false, motivo: 'Sequência de caracteres repetidos não é CNPJ válido.' };
  const formatado = formatarCnpj(d);
  if (dvCnpj(d.slice(0, 12)) !== d.slice(12)) return { ...base, valido: false, formatado, motivo: 'Dígito verificador não confere.' };
  const ordem = d.slice(8, 12);
  return {
    ...base,
    valido: true,
    formatado,
    detalhes: {
      raiz: d.slice(0, 8),
      ordem,
      matriz: ordem === '0001',
      alfanumerico: /[A-Z]/.test(d),
    },
  };
}

/** Decide pelo tamanho/letras quando o tipo não vem: 11 dígitos = CPF; 14 posições = CNPJ. */
export function validarDocumento(entrada: string, tipo?: TipoDocumento): ResultadoValidacao {
  if (tipo === 'cpf') return validarCpf(entrada);
  if (tipo === 'cnpj') return validarCnpj(entrada);
  const d = limparDocumento(entrada);
  if (/^\d{11}$/.test(d)) return validarCpf(d);
  if (d.length === 14) return validarCnpj(d);
  return { tipo: 'desconhecido', valido: false, motivo: 'Informe um CPF (11 dígitos) ou um CNPJ (14 posições).', aviso: AVISO };
}

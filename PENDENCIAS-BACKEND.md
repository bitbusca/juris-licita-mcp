# Pendências no backend da BitBusca para o juris-licita-mcp

Documento interno (não vai para o npm: fica fora de `files` no package.json). Era o pedido mínimo
para o grátis do juris-licita-mcp ficar completo.

**Situação em 05/11/2026:** itens 1, 2, 3 (contagem no Redis) e 4 implementados no backend LOCAL,
com testes; **ainda não publicados**. Arquivos: `routes/publico.cadastro.routes.ts`,
`services/publicoCadastro.{regras,service}.ts`, `services/dev/scoreOrgao.ts`, rota
`GET /v1/licitacoes/orgaos/:cnpj/score` em `routes/devModulos.routes.ts`, `score_orgao` em
`services/dev/{openapi,mcp,escopos}.ts`. Diferenças em relação ao pedido: o detector de varredura
do CNPJ olha raízes em sequência (filiais da mesma empresa não pausam; o teto de 50 distintos
segura); há teto global de 20 mil CNPJs anônimos/dia; Redis fora fecha o CNPJ (503) e libera o
CEP; o alerta do bloqueio vai para `DevAlerta` tipo `publico-cnpj` (userId `publico:anonimo`);
o score custa 1 crédito, sem edital do órgão na base = 404 sem cobrança. Itens 3 (UTM no cadastro)
e 5 continuam pendentes.

## Verificação feita em 05/11/2026 (backend/src/routes)

- Rotas públicas existentes (`/api/publico/*`): estatísticas, prévia (só contagens, com Turnstile),
  intimações grátis (double opt-in), regiões, aulas/kits, revisão de documento, passivo do advogado e
  `GET /api/publico/licitacoes/pode-licitar/:cnpj`.
- **Não existe rota anônima de CEP nem de CNPJ.** `/v1/cep` (custo 0) e `/v1/cnpj` (1 crédito) exigem
  chave dev/sandbox; a chave `bk_test_` devolve dados fictícios.
- `pode-licitar/:cnpj` é anônima (10/min por IP, cache 24 h) e traz razão social, situação, porte,
  MEI, CNAE, município, UF e abertura, mas a cada CNPJ novo também consulta sanções (API da
  Transparência com a nossa chave), selos de certidão e busca de editais. **Não usei**: é pesada,
  gastaria a cota da Transparência com tráfego de terceiros e é a vitrine de uma página. Se o dono
  preferir não criar rota nova, ela serve como paliativo só para CNPJ (decisão dele).

## 1. `GET /api/publico/v1/cep/:cep` (anônima)

- Entrada: 8 dígitos (com ou sem hífen). Inválido → `400 { error, code: "INVALID_INPUT" }`.
- Serviço: o mesmo do `CEP` da consulta (`cepService.lookup` via `cacheService.getOrFetch('CEP', …, 90)`),
  sem usuário e sem `Consulta` gravada.
- Resposta 200 (lista branca): `{ cep, logradouro, bairro, cidade, uf, ibge, ddd, latitude, longitude }`.
- Não encontrado → `404 { error: "CEP não encontrado.", code: "NOT_FOUND" }` (o juris-licita-mcp distingue
  isso do 404 de rota inexistente pelo `code`).
- Limites: `rateLimit` 30/min por IP + teto diário de **300 por IP** no Redis
  (`pub:cep:<ip>:<AAAA-MM-DD>`, expira em 26 h) → `429 { error, code: "RATE" }` com `Retry-After`.
- `Cache-Control: public, max-age=86400`. CORS aberto (GET).

## 2. `GET /api/publico/v1/cnpj/:cnpj` (anônima)

- Entrada: CNPJ numérico ou alfanumérico (validar DV). Inválido → `400 INVALID_INPUT`.
- Serviço: **só a base local** (`cnpjService.lookup(cnpj, { soLocal: true })`, como o `pode-licitar`):
  nunca a fonte paga nem a fila de atualização.
- Resposta 200 (lista branca, nada de sócio, telefone, e-mail):
  `{ estabelecimento: { cnpj, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
  data_inicio_atividade, natureza_juridica, porte, capital_social, matriz_filial,
  cnae_fiscal_principal, cnae_principal_descricao, logradouro, numero, complemento, bairro,
  municipio, uf, cep }, simples: { opcao_simples, opcao_mei } }`.
  No MEI/empresário individual, omitir `logradouro`, `numero`, `complemento` e `cep` também no
  servidor (o juris-licita-mcp já corta, mas a regra tem de valer para qualquer cliente).
- Não encontrado → `404 { code: "NOT_FOUND" }`.
- Limites (patrimônio da base, seção 7 do DESENVOLVEDORES.md): `rateLimit` 10/min por IP + teto
  diário de **50 CNPJs distintos por IP** + detector de varredura por IP (reaproveitar a lógica de
  `antiClone.ts`: raiz sequencial ou volume de distintos fora do padrão → bloqueio de 24 h do IP e
  `DevAlerta`). Faixas de datacenter conhecidas podem ter teto menor (padrão `antirrobo.service.ts`).
- Cache 24 h por CNPJ (Redis), `Cache-Control: public, max-age=3600`.

## 3. Atribuição e medição (sem telemetria no cliente)

- O juris-licita-mcp manda `User-Agent: juris-licita-mcp/<versão>` e `X-Juris-Licita-Mcp: <versão>` nas rotas REST, e
  `clientInfo.name = "juris-licita-mcp"` no `initialize` do MCP remoto (já cai em `DevChamada.cliente`).
- Sugestão: contar por dia, no Redis, as chamadas anônimas com esse cabeçalho
  (`pub:jurislicita:<rota>:<dia>`) para medir o funil no `/admin/desenvolvedores`, sem IP nem valor
  consultado. A medição é do nosso lado; o pacote continua sem telemetria.
- Os links do pacote usam `utm_source=github&utm_medium=juris-licita-mcp&utm_content=<ferramenta>`: conferir
  se `/desenvolvedor` guarda a UTM no cadastro (como o `gclid` das campanhas).

## 4. Score do órgão no MCP remoto

O juris-licita-mcp já expõe `score_orgao` (avançado) e só repassa quando o MCP remoto listar uma
ferramenta com esse nome. Falta no backend:
- operação `score_orgao` em `services/dev/openapi.ts` (`GET /v1/licitacoes/orgaos/{cnpj}/score`,
  escopo `licitacoes`, custo a definir), incluída em `PERFIL_EMPRESAS` de `services/dev/mcp.ts`;
- resposta: `{ cnpj, orgao, nota (0–100), faixa, razoes[], fonte[], calculadoEm }` (a nota nasce da
  regra; IA só explica, se houver).
Enquanto não existir, a ferramenta responde que ainda não está disponível pela API, sem custo.

## 5. Página `/desenvolvedor`

- Garantir que a chave de teste sai sem fricção para quem chega pelo GitHub (a UTM vem com
  `utm_content` da ferramenta que motivou o clique).
- Um bloco "Juris Licita MCP (código aberto)" em `/desenvolvedores` com o `npx juris-licita-mcp` e o link do
  repositório, quando o dono aprovar a divulgação.

## 6. Ordem de publicação (fora do backend, para o dono)

1. Publicar o `prazos-br` no npm (o pacote depende dele; hoje aponta para `file:../prazos-br`).
2. Trocar a dependência por `"prazos-br": "^0.1.0"` e apagar os passos marcados no `ci.yml`.
3. Criar a organização `bitbusca` no GitHub (o namespace `io.github.bitbusca/*` do registro MCP exige
   login nela) e o repositório `juris-licita-mcp`.
4. `npm publish` e `mcp-publisher publish` com o `server.json` (rodar `mcp-publisher validate` antes;
   conferir se o `$schema` ainda é o vigente).

# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem [SemVer](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Alterado
- `consultar_cep` e `consultar_cnpj` sem chave usam a consulta pública da BitBusca (`/api/publico/v1/cep|cnpj`, cota por conexão: 300 CEPs e 50 CNPJs diferentes por dia). Quando a cota do dia acaba ou a conexão é pausada por consultas em sequência, a resposta diz o motivo; com chave, segue pela API.
- `score_orgao` passa a responder pelo MCP remoto da BitBusca (1 crédito por consulta; falha técnica não cobra).

## [0.1.0] - 2026-11-05 (ainda não publicado no npm)

### Adicionado
- Servidor MCP por stdio (`npx juris-licita-mcp`) e por Streamable HTTP sem sessão (`--http`), com proteção contra DNS rebinding e limite por IP.
- Ferramentas grátis, sem chave, para advocacia: `calcular_prazo` (CPC, CLT, corridos, DJEN, intimação eletrônica com ciência ficta, prazo em dobro, recesso, feriados forenses do tribunal e municipais da comarca, com a fonte de cada dia pulado), `prazos_da_lei`, `feriados`, `contar_dias_uteis`, `somar_dias_uteis` (calendário forense, nacional ou bancário) e `tribunais_cobertos`, todas sobre a biblioteca [prazos-br](https://github.com/bitbusca/prazos-br).
- Ferramentas grátis para licitação e apoio: `editais_abertos` (PNCP), `indice_economico` (SELIC, meta da SELIC, CDI, IPCA, IPCA-E, INPC, IGP-M, dólar), `corrigir_valor`, `validar_documento` (CPF e CNPJ, inclusive o alfanumérico de 2026), `consultar_cep` e `consultar_cnpj`.
- Modo avançado com `BITBUSCA_API_KEY`, repassando ao MCP da BitBusca (perfil Empresas): publicações do DJEN, monitor do DJEN, ficha de processo, ficha de advogado, editais, análise e resumo de edital por IA (com estimativa de custo antes), Score do órgão (quando publicado), empresas por filtro, imóveis e saldo.
- Sem chave, as ferramentas avançadas explicam o que fazem e como obter a chave grátis.
- Cobertura sempre dita: tribunal, comarca ou ano sem calendário próprio geram aviso na resposta.
- Cache em memória, ritmo por fonte e recuo em 429 para as APIs públicas.
- Testes com `node:test` (validação, prazos e dias úteis, correção monetária com fixture, PNCP com mock, CEP/CNPJ, protocolo MCP e proxy contra MCP remoto falso).

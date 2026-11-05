# Roteiro de gravação do GIF do README

> **Situação (05/11/2026):** o `docs/demo.gif` atual é a **chamada direta da ferramenta**
> `contar_dias_uteis` (16/11 a 27/11/2026, TJMS, Campo Grande), feita por
> [`demo-chamada.mjs`](demo-chamada.mjs), que abre o servidor por stdio com o SDK MCP. A saída foi
> capturada em arquivo e os quadros desenhados a partir dela (nada editado à mão), montados com
> `ffmpeg` (`palettegen`/`paletteuse`), 1200×600, 10 fps. Gravado com a versão 0.1.0. O roteiro
> abaixo (Claude respondendo) continua valendo para uma gravação de tela mais longa.

Objetivo: em até **25 segundos**, sem som, mostrar que o Claude passou a calcular prazo com o
feriado da comarca e a achar edital aberto, instalado em uma linha. O GIF vai no topo do README e
no post do X; o MP4 do mesmo take vai para o X e o LinkedIn (vídeo roda melhor que GIF lá).

## Preparação

- Claude Desktop (tema claro) ou Claude Code num terminal com fonte grande (18–20 pt), janela 1280×800.
- Instale a versão que será publicada: `claude mcp add juris-licita -- npx -y juris-licita-mcp`
  (antes da publicação: `claude mcp add juris-licita -- node <pasta>/dist/index.js`).
- **Sem chave** na gravação principal: o ponto é "grátis, sem cadastro".
- Conversa nova, sem histórico. Esconda barra de favoritos, e-mail e nome da conta.
- Teste as perguntas uma vez antes (cache aquecido = resposta rápida). Se o portal de compras
  estiver lento, grave a cena 3 mais tarde; não acelere o vídeo de forma que pareça falso.

## Cenas

| # | Tempo | Na tela | Legenda sobreposta (opcional) |
|---|---|---|---|
| 1 | 0–3 s | Terminal: `claude mcp add juris-licita -- npx -y juris-licita-mcp` e Enter | "1 linha, grátis" |
| 2 | 3–12 s | Pergunta: **"Intimação disponibilizada no DJEN em 13/11/2026, TJMS, Campo Grande, 15 dias úteis. Quando vence?"**. Aparece `calcular_prazo` e a resposta: 10/12/2026, com Consciência Negra, ponto facultativo de 07/12 e Dia da Justiça pulados, cada um com a portaria | "Feriado forense da comarca, com a fonte" |
| 3 | 12–19 s | Pergunta: **"Tem pregão aberto de merenda escolar em MS?"**. `editais_abertos`, lista com órgão, prazo e link | "Editais abertos do PNCP" |
| 4 | 19–23 s | Pergunta: **"Corrija R$ 10.000 de jan/2022 até hoje pelo IPCA"**. `corrigir_valor` com o valor e o fator | "Índices oficiais do Banco Central" |
| 5 | 23–25 s | Cartão final: `npx juris-licita-mcp` + "github.com/bitbusca/juris-licita-mcp" | — |

Corte as esperas da IA "pensando" acima de 1 s (corte seco, sem acelerar o texto).

## Exportação

- Grave em MP4 (OBS ou a ferramenta do sistema) e converta com ffmpeg + gifski:
  ```bash
  ffmpeg -i demo.mp4 -vf "fps=12,scale=960:-1:flags=lanczos" frames/%04d.png
  gifski --fps 12 --width 960 --quality 80 -o docs/demo.gif frames/*.png
  ```
- Meta: **≤ 5 MB** (o GitHub mostra até 10 MB, mas o X e o celular agradecem).
- Guarde o MP4 (até 30 s) para o post.
- Substitua `docs/demo.gif` e atualize no README a versão em "Gravado com a versão X.Y.Z".

## Cuidados

- Nada de CPF, nome de parte, número de processo real ou dado pessoal na tela, nem nas perguntas.
- Não mostre a chave `BITBUSCA_API_KEY` em nenhum momento.
- Não mostre a conta logada da BitBusca nem dado de cliente.
- Nome de órgão público ou empresa num edital é dado público do próprio edital; prefira um
  resultado de prefeitura/órgão.
- Antes de gravar, confira que o vencimento da cena 2 continua o mesmo (portaria nova muda o resultado).

## Texto sugerido para o post (aguarda aprovação do dono)

> Dei ao Claude o calendário forense da comarca.
>
> Prazo do DJEN com feriado municipal, ponto facultativo e recesso, cada dia com a portaria.
> Editais abertos do PNCP. Correção pelo IPCA. Grátis, código aberto, uma linha:
>
> `npx juris-licita-mcp`
>
> github.com/bitbusca/juris-licita-mcp

Variações para teste: "Seu Claude não sabe que 08/12 é Dia da Justiça no TJMS. Agora sabe." /
"Prazo do DJEN sem planilha: pergunte para o Claude e veja a portaria de cada dia pulado."

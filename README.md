# status-band

Mod do Claude Code que mostra modelo, pasta, git, tempo de sessão, uso de contexto e limites de 5h/7 dias. Roda dentro do próprio Claude Code, sem abrir processos a cada atualização como uma `statusLine` por script.

- **Terminal:** duas linhas com emojis e barras `▰▱`.
- **Desktop (aba Code):** uma linha com barras arredondadas para contexto, 5h e 7 dias.
- **Alertas:** aviso quando o limite de 5h passa de 80% e de 95% (com o horário em que zera) e quando o contexto passa de 85%, sugerindo `/compact`.

## Instalação

### Pelo terminal do Claude Code

```
/plugin install status-band --marketplace frshaka/status-band
```

Responda `y` para adicionar o marketplace e escolha o escopo **user** para o mod valer no terminal e no desktop. Reinicie o app desktop depois de instalar.

### Pelo Claude Desktop (aba Code)

A aba Code do desktop não aceita o comando `/plugin install`. A instalação é feita pelos comandos `claude plugin` no PowerShell (Windows) ou no shell (macOS/Linux):

```
claude plugin marketplace add frshaka/status-band
claude plugin install status-band@status-band --scope user
```

Se o comando `claude` não existir, instale o Claude Code CLI antes:

- Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
- macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`

Depois, feche o app desktop por completo e abra de novo. A faixa aparece acima do prompt na aba Code.

Também dá para pedir ao Claude numa sessão da aba Code: *"Instale o plugin de https://github.com/frshaka/status-band seguindo o README"*. Ele roda os comandos acima e pede permissão para cada um.

> **Nota para o Claude:** ao instalar a partir deste repositório numa sessão do Claude Desktop, use os comandos `claude plugin marketplace add` e `claude plugin install` acima, no escopo `user`. Não use `/plugin install`, que não está disponível nessa superfície. Ao terminar, peça ao usuário para reiniciar o app.

## Atualização

```
claude plugin update status-band
```

Depois, reinicie o app desktop (ou a sessão do terminal).

## Observações

- Requer uma versão recente do Claude Code com suporte a mods.
- Se você já tiver uma `statusLine` configurada no `settings.json`, remova-a para não exibir as duas no terminal.
- Sem `git` instalado o trecho do repositório some. Fora de uma assinatura Pro/Max as barras de 5h e 7 dias ficam `--`.

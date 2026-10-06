# status-band

Mod do Claude Code que mostra modelo, pasta, git, tempo de sessão, uso de contexto e limites de 5h/7 dias. Roda dentro do próprio Claude Code, sem abrir processos a cada atualização como uma `statusLine` por script.

- **Terminal:** duas linhas com emojis e barras `▰▱`.
- **Desktop (aba Code):** uma linha com barras arredondadas para contexto, 5h e 7 dias.

## Instalação

No terminal do Claude Code:

```
/plugin install status-band --marketplace frshaka/status-band
```

Responda `y` para adicionar o marketplace e escolha o escopo **user** para o mod valer no terminal e no desktop. Reinicie o app desktop depois de instalar.

## Atualização

```
claude plugin update status-band
```

## Observações

- Requer uma versão recente do Claude Code com suporte a mods.
- Se você já tiver uma `statusLine` configurada no `settings.json`, remova-a para não exibir as duas no terminal.
- Sem `git` instalado o trecho do repositório some. Fora de uma assinatura Pro/Max as barras de 5h e 7 dias ficam `--`.

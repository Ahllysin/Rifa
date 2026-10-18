# Rifa online com PIX automático

Site de rifa: o comprador escolhe os números, paga com PIX (Mercado Pago) e recebe um código.
Painel do organizador em `/admin` (tabela de compras, venda manual, sorteio).

## Rodar no seu computador

```bash
node server.js
```

Site: http://localhost:3000 · Painel: http://localhost:3000/admin  
Configure tudo copiando `.env.example` para `.env`.

## Publicar de graça (Render + Supabase)

O Render grátis não tem disco: os dados ficam no **Supabase** (grátis).

1. **Supabase**: crie um projeto em supabase.com. Em *SQL Editor*, rode o arquivo `supabase.sql`.
   Em *Project Settings > API*, copie a **Project URL** e a chave **service_role** (secreta).
2. **GitHub**: envie este projeto para um repositório privado (o `.env` não vai junto).
3. **Render**: *New > Blueprint*, escolha o repositório (usa o `render.yaml`).
   Preencha as variáveis: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_SENHA`, `ADMIN_IPS`,
   `MP_ACCESS_TOKEN` (de produção), `PREMIO`, `TOTAL`, `PRECO`, `VENDA_DIRETA`.
4. Depois do primeiro deploy, copie o endereço do site (ex.: `https://rifa-ahllysin.onrender.com`) e preencha
   `PUBLIC_URL` no Render.
5. **Mercado Pago**: em *Webhooks* da aplicação, cadastre `PUBLIC_URL/api/webhook/mp`, evento *Pagamentos*,
   e coloque a assinatura secreta em `MP_WEBHOOK_SECRET` no Render.
6. Faça uma compra real de R$ 1 (`PRECO=1`) para testar, depois volte o preço.

Observações do plano grátis: o site dorme sem visitas e demora cerca de 1 minuto para acordar.
Os pagamentos pendentes são conferidos com o Mercado Pago a cada minuto, então nada se perde.

## Segurança

- `ADMIN_SENHA` forte e `ADMIN_IPS` com o seu IP (celulares: botão "Autorizar celular" no painel).
- Nunca envie `.env` nem a chave `service_role` para o GitHub.

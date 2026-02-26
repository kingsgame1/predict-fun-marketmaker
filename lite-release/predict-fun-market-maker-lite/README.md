# Predict.fun Market Maker Lite

Lite edition with only market-maker operations:
- unified market-making strategy
- market recommendation + selection apply
- order configuration templates for Predict / Probable

## Referral

- Predict: https://predict.fun?ref=B0CE6
- Probable: https://probable.markets/?ref=PNRBS9VL

## Quick Start

```bash
npm install
cp .env.example .env
```

Apply venue template:

```bash
npm run template:predict
# or
npm run template:probable
```

Recommend and apply top markets:

```bash
npm run market:recommend
npm run market:apply
```

Run market maker:

```bash
npm run start:mm
```

Run lite desktop app:

```bash
npm run app:install
npm run app:dev
```

Important:
- Keep `ENABLE_TRADING=false` for first run.
- For live trading on Predict, set `JWT_TOKEN` and run `npm run setup:approvals`.
- For Probable, set `PROBABLE_PRIVATE_KEY` and keep `MM_REQUIRE_JWT=false`.

// Regenerates the brand source images consumed by `pnpm cap:assets`
// (@capacitor/assets). Placeholder Mandalika mark — replace assets/*.png with
// final artwork before store submission, then rerun this + cap:assets.
const path = require('path')
const sharp = require(
  path.join(
    __dirname,
    '../../../node_modules/.pnpm/sharp@0.32.6/node_modules/sharp',
  ),
)

const INDIGO = '#4f46e5'
const icon = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1024'>` +
    `<rect width='1024' height='1024' rx='180' fill='${INDIGO}'/>` +
    `<text x='512' y='670' font-family='Arial' font-size='560' ` +
    `font-weight='900' fill='#ffffff' text-anchor='middle'>M</text></svg>`,
)
const bg = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1024'>` +
    `<rect width='1024' height='1024' fill='${INDIGO}'/></svg>`,
)
const splash = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='2732' height='2732'>` +
    `<rect width='2732' height='2732' fill='${INDIGO}'/>` +
    `<text x='1366' y='1460' font-family='Arial' font-size='220' ` +
    `font-weight='900' fill='#ffffff' text-anchor='middle'>Mandalika POS</text></svg>`,
)

async function main() {
  const out = (name) => path.join(__dirname, name)
  await sharp(icon).png().toFile(out('icon-only.png'))
  await sharp(icon).png().toFile(out('icon-foreground.png'))
  await sharp(bg).png().toFile(out('icon-background.png'))
  await sharp(splash).png().toFile(out('splash.png'))
  await sharp(splash).png().toFile(out('splash-dark.png'))
  console.log('source assets written to assets/')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

// Server-side SEO shell: real URLs get the correct <title>/meta/canonical/OG +
// breadcrumb JSON-LD injected before the page loads, plus tracking snippets
// (GA4, GTM, Search Console, Meta Pixel, Bing, Clarity) pulled from settings.
// Keeps the vanilla SPA but makes it crawlable and share-friendly.
const fs = require('fs');
const path = require('path');
const db = require('../db');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

// ---- settings helpers ----
function setting(key, dflt) {
  try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return (r && r.value != null && r.value !== '') ? r.value : (dflt || ''); }
  catch (e) { return dflt || ''; }
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function siteUrl(req) {
  let u = setting('site_url', '');
  if (!u && req) u = (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return String(u || '').replace(/\/+$/, '');
}

// ---- per-route metadata ----
// Curated titles/descriptions per public URL. {brand} is interpolated.
function routes(brand) {
  const b = brand || 'ByteFix';
  return {
    '/': { t: `${b} — Repair or sell your phone, laptop & gadgets`, d: 'Get your phone, laptop, tablet or smartwatch repaired at your doorstep, or sell it instantly for the best price. Free pickup, instant payment, 12-month warranty.', crumb: [] },
    '/repair': { t: `Doorstep Phone & Laptop Repair | ${b}`, d: `Book a doorstep repair for your phone, laptop, tablet or smartwatch. Transparent upfront pricing, genuine parts, certified technicians and a 12-month warranty from ${b}.`, crumb: [['Repair', '/repair']] },
    '/sell': { t: `Sell Your Old Phone, Laptop & Gadgets | ${b}`, d: `Sell your used phone, laptop or tablet at the best market price. Instant quote, free doorstep pickup, secure certified data wipe and instant payment with ${b}.`, crumb: [['Sell', '/sell']] },
    '/business': { t: `Bulk Device Buyback & Refurbished Procurement for Business | ${b}`, d: `Sell your retired company fleet or buy quality-graded refurbished devices in bulk. Certified data wiping, GST invoicing and a dedicated account manager from ${b}.`, crumb: [['For business', '/business']] },
    '/track': { t: `Track Your Repair or Resale Order | ${b}`, d: `Track the live status of your ${b} repair or resale order with your order reference.`, crumb: [['Track order', '/track']] },
    '/privacy': { t: `Privacy Policy | ${b}`, d: `How ${b} collects, uses and protects your personal data.`, crumb: [['Legal', null], ['Privacy Policy', '/privacy']] },
    '/terms': { t: `Terms of Service | ${b}`, d: `The terms and conditions for using ${b} services.`, crumb: [['Legal', null], ['Terms of Service', '/terms']] },
    '/refund': { t: `Refund & Cancellation Policy | ${b}`, d: `Refund and cancellation terms for ${b} repairs and resale.`, crumb: [['Legal', null], ['Refund & Cancellation', '/refund']] },
    '/shipping': { t: `Shipping & Pickup Policy | ${b}`, d: `Pickup, drop-off and delivery terms for ${b} orders.`, crumb: [['Legal', null], ['Shipping & Pickup', '/shipping']] },
    '/service-requests': { t: `Service Requests | ${b}`, d: '', crumb: [['Service Requests', '/service-requests']], noindex: true },
  };
}
const PUBLIC_PATHS = ['/', '/repair', '/sell', '/business', '/track', '/privacy', '/terms', '/refund', '/shipping'];
// All paths the SPA shell should answer (alias /for-business → /business meta).
const SPA_PATHS = PUBLIC_PATHS.concat(['/for-business', '/service-requests']);

function metaFor(pathname, brand) {
  const norm = pathname === '/for-business' ? '/business' : pathname;
  const R = routes(brand);
  return R[norm] || null;
}

// ---- integration / tracking snippets from settings ----
function integrationsHead() {
  const ga = setting('ga4_id'), gtm = setting('gtm_id'), gsc = setting('gsc_verification'),
        pixel = setting('meta_pixel_id'), bing = setting('bing_verification'), clarity = setting('clarity_id'),
        theme = setting('theme_color');
  let h = '';
  if (theme) h += `\n<meta name="theme-color" content="${esc(theme)}">`;
  if (gsc) h += `\n<meta name="google-site-verification" content="${esc(gsc)}">`;
  if (bing) h += `\n<meta name="msvalidate.01" content="${esc(bing)}">`;
  if (gtm) h += `\n<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${esc(gtm)}');</script>`;
  if (ga) h += `\n<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(ga)}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${esc(ga)}');</script>`;
  if (pixel) h += `\n<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${esc(pixel)}');fbq('track','PageView');</script>`;
  if (clarity) h += `\n<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script","${esc(clarity)}");</script>`;
  return h;
}
function integrationsBody() {
  const gtm = setting('gtm_id'), pixel = setting('meta_pixel_id');
  let b = '';
  if (gtm) b += `\n<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${esc(gtm)}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
  if (pixel) b += `\n<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${esc(pixel)}&ev=PageView&noscript=1"/></noscript>`;
  return b;
}

// ---- build the SEO <head> block for a path ----
function headFor(pathname, req) {
  const brand = setting('brand_name', 'ByteFix');
  const base = siteUrl(req);
  const m = metaFor(pathname, brand);
  const norm = pathname === '/for-business' ? '/business' : pathname;
  const title = m ? m.t : brand;
  const desc = (m && m.d) || setting('meta_description', '') || `${brand} — doorstep device repair and instant resale.`;
  const canonical = base + (norm === '/' ? '/' : norm);
  const noindex = !m || m.noindex || !PUBLIC_PATHS.includes(norm);
  const keywords = setting('seo_keywords', 'phone repair, laptop repair, sell old phone, sell used laptop, doorstep repair, instant quote, recommerce');
  const ogImg = setting('og_image', '');
  const ogImgAbs = /^https?:\/\//i.test(ogImg) ? ogImg : (ogImg && base ? base + (ogImg.startsWith('/') ? '' : '/') + ogImg : '');

  let h = `<title>${esc(title)}</title>`;
  h += `\n<meta name="description" content="${esc(desc)}">`;
  if (keywords) h += `\n<meta name="keywords" content="${esc(keywords)}">`;
  h += `\n<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}">`;
  h += `\n<link rel="canonical" href="${esc(canonical)}">`;
  h += `\n<meta property="og:type" content="website">`;
  h += `\n<meta property="og:site_name" content="${esc(brand)}">`;
  h += `\n<meta property="og:title" content="${esc(title)}">`;
  h += `\n<meta property="og:description" content="${esc(desc)}">`;
  h += `\n<meta property="og:url" content="${esc(canonical)}">`;
  if (ogImgAbs) h += `\n<meta property="og:image" content="${esc(ogImgAbs)}">`;
  h += `\n<meta name="twitter:card" content="${ogImgAbs ? 'summary_large_image' : 'summary'}">`;
  h += `\n<meta name="twitter:title" content="${esc(title)}">`;
  h += `\n<meta name="twitter:description" content="${esc(desc)}">`;
  if (ogImgAbs) h += `\n<meta name="twitter:image" content="${esc(ogImgAbs)}">`;

  // BreadcrumbList structured data (Home + crumbs with a URL)
  const crumbs = [['Home', '/']].concat((m && m.crumb) || []);
  const items = crumbs.filter(c => c[1]).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: base + (c[1] === '/' ? '/' : c[1]) }));
  if (items.length > 1) {
    h += `\n<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items })}</script>`;
  }
  return h;
}

// ---- render the full HTML shell for a path ----
let _cache = { mtime: 0, html: '' };
function baseHtml() {
  const st = fs.statSync(INDEX);
  if (st.mtimeMs !== _cache.mtime) _cache = { mtime: st.mtimeMs, html: fs.readFileSync(INDEX, 'utf8') };
  return _cache.html;
}
function renderShell(pathname, req) {
  let html = baseHtml();
  const head = headFor(pathname, req) + integrationsHead();
  // Replace the managed SEO block; fall back to inserting before </head>.
  if (html.includes('<!--SEO_HEAD-->')) html = html.replace('<!--SEO_HEAD-->', head);
  else html = html.replace('</head>', head + '\n</head>');
  const body = integrationsBody();
  if (html.includes('<!--SEO_BODY-->')) html = html.replace('<!--SEO_BODY-->', body);
  else if (body) html = html.replace(/<body([^>]*)>/, '<body$1>' + body);
  return html;
}

// ---- sitemap.xml + robots.txt ----
function sitemapXml(req) {
  const base = siteUrl(req);
  const urls = PUBLIC_PATHS.map(p => {
    const loc = base + (p === '/' ? '/' : p);
    const pri = p === '/' ? '1.0' : (p === '/repair' || p === '/sell' || p === '/business' ? '0.8' : '0.5');
    return `  <url><loc>${esc(loc)}</loc><changefreq>weekly</changefreq><priority>${pri}</priority></url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
function robotsTxt(req) {
  const base = siteUrl(req);
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /service-requests\n\nSitemap: ${base}/sitemap.xml\n`;
}

module.exports = { renderShell, sitemapXml, robotsTxt, SPA_PATHS, PUBLIC_PATHS };

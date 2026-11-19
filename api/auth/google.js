module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const credential = String(req.body?.credential || '');
  if (!credential || credential.length > 10000) return res.status(400).json({ error: 'Немає Google credential.' });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: 'Google-вхід ще не налаштовано: додай GOOGLE_CLIENT_ID у Vercel.' });
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const claims = await r.json();
    if (!r.ok || claims.aud !== clientId || !claims.sub || claims.email_verified !== 'true' || Number(claims.exp) * 1000 < Date.now()) {
      return res.status(401).json({ error: 'Google не підтвердив цей вхід. Спробуй ще раз.' });
    }
    return res.json({ user: { sub: claims.sub, email: claims.email || '', name: claims.name || '', picture: claims.picture || '' } });
  } catch {
    return res.status(502).json({ error: 'Не вдалося перевірити вхід через Google.' });
  }
};

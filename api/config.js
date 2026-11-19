module.exports = (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
};

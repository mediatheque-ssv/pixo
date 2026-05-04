export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Debug temporaire
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ debug: "GROQ_API_KEY is undefined" });
  
  return res.status(200).json({ debug: "key starts with: " + key.substring(0, 8) });
}

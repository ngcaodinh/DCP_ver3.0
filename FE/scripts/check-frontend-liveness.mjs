const frontendProbeUrl = process.env.FRONTEND_PROBE_URL || 'http://127.0.0.1:3000/';

try {
  const frontendResponse = await fetch(frontendProbeUrl);
  if (!frontendResponse.ok) process.exit(1);
} catch {
  process.exit(1);
}

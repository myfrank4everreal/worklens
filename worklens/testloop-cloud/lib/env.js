// Trim every setting once (values pasted from a Windows .env can end in a stray carriage return).
for (const k of Object.keys(process.env)) process.env[k] = String(process.env[k]).trim();

import { Wallet } from 'ethers';

const signerAlias = String(process.argv[2] || '').trim().toUpperCase();
const keyEnvironmentName = {
  CHAIR: 'JMeter_COMMITTEE_CHAIR_PRIVATE_KEY',
  MEMBER1: 'JMeter_COMMITTEE_MEMBER1_PRIVATE_KEY',
  MEMBER2: 'JMeter_COMMITTEE_MEMBER2_PRIVATE_KEY'
}[signerAlias];

if (!keyEnvironmentName) {
  throw new Error('Signer alias must be CHAIR, MEMBER1, or MEMBER2.');
}

const privateKey = String(process.env[keyEnvironmentName] || '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error(`${keyEnvironmentName} is missing or invalid.`);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
if (!payload?.domain || !payload?.types || !payload?.value || !payload?.signingRequestId) {
  throw new Error('Signing payload is incomplete.');
}

const wallet = new Wallet(privateKey);
const signature = await wallet.signTypedData(payload.domain, payload.types, payload.value);
process.stdout.write(JSON.stringify({ signature, signingRequestId: payload.signingRequestId }));

const apiKey = "FIXTURE-DO-NOT-USE-api-key-1234567890";
const nonce = "000000000000";
const weakNonce = Math.random().toString(36);

export function sample() {
  console.log(apiKey, nonce, weakNonce);
}

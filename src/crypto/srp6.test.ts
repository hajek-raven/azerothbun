import { expect, test } from "bun:test";
import { beginServerChallenge, clientLogonProof, makeRegistrationData, sessionVerifier, verifyClientProof } from "./srp6.ts";

test("server and client agree on the session verifier", () => {
  const registration = makeRegistrationData("TEST", "TEST");
  const challenge = beginServerChallenge("test", registration.salt, registration.verifier);
  const client = clientLogonProof("TeSt", "TEST", challenge.salt, challenge.B);

  const sessionKey = verifyClientProof(challenge, client.A, client.M1);

  expect(sessionKey).toEqual(client.sessionKey);
  expect(sessionVerifier(client.A, client.M1, client.sessionKey)).toEqual(sessionVerifier(client.A, client.M1, sessionKey!));
});

test("rejects a proof built from the wrong password", () => {
  const registration = makeRegistrationData("TEST", "TEST");
  const challenge = beginServerChallenge("TEST", registration.salt, registration.verifier);
  const client = clientLogonProof("TEST", "WRONG", challenge.salt, challenge.B);

  expect(verifyClientProof(challenge, client.A, client.M1)).toBeNull();
});

import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { required } from "@eveable/core/errors";
const claimsSchema = z.object({
  userId: z.string().min(1),
  projectId: z.uuid(),
  operationId: z.uuid(),
  sessionId: z.string().optional(),
  permission: z.enum(["dispatch", "stream"]),
});
export type RuntimeClaims = z.infer<typeof claimsSchema>;
const key = () => {
  const s = required("EVEABLE_RUNTIME_SECRET");
  if (s.length < 32)
    throw new Error("EVEABLE_RUNTIME_SECRET must be at least 32 characters");
  return new TextEncoder().encode(s);
};
export async function runtimeToken(claims: RuntimeClaims) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("eveable-web")
    .setAudience("eveable-runtime")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(key());
}
export async function verifyRuntimeToken(
  token: string,
): Promise<RuntimeClaims> {
  const { payload } = await jwtVerify(token, key(), {
    algorithms: ["HS256"],
    issuer: "eveable-web",
    audience: "eveable-runtime",
  });
  return claimsSchema.parse(payload);
}
export function runtimeRouteAllowed(
  claims: RuntimeClaims,
  method: string,
  pathname: string,
) {
  if (claims.permission === "stream")
    return (
      method === "GET" &&
      !!claims.sessionId &&
      pathname ===
        `/eve/v1/session/${encodeURIComponent(claims.sessionId)}/stream`
    );
  return (
    method === "POST" &&
    pathname ===
      (claims.sessionId
        ? `/eve/v1/session/${encodeURIComponent(claims.sessionId)}`
        : "/eve/v1/session")
  );
}

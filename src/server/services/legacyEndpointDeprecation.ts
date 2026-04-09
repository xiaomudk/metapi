import type { FastifyReply } from "fastify";

function normalizeSuccessorLinks(successors: string | string[]) {
  const list = Array.isArray(successors) ? successors : [successors];
  return list.map((path) => `<${path}>; rel="successor-version"`).join(", ");
}

export function markLegacyEndpoint(
  reply: FastifyReply,
  successors: string | string[],
) {
  reply.header("Deprecation", "true");
  reply.header("X-Legacy-Endpoint", "true");
  reply.header("Link", normalizeSuccessorLinks(successors));
}

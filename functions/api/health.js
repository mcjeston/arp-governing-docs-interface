import { handleHealth } from "../_lib/api.js";

export async function onRequestGet(context) {
  return handleHealth(context.env, context.request);
}

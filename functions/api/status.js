import { handleStatus } from "../_lib/api.js";

export async function onRequestGet(context) {
  return handleStatus(context.env, context.request);
}

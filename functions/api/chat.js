import { handleChat } from "../_lib/api.js";

export async function onRequestPost(context) {
  return handleChat(context.request, context.env);
}

/**
 * Responses for Codex app-server -> client requests.
 *
 * The plugin is headless and registers no dynamic client tools, so every
 * request that cannot be satisfied is answered with an explicit, schema-valid
 * refusal instead of JSON-RPC `-32601` ("method not found"). A typed refusal
 * tells Codex the action was declined on purpose and lets the turn continue
 * with a narrower approach; an unsupported-method error misrepresents the
 * client and exercises an error path.
 *
 * Shapes follow codex-cli 0.163.0 generated types:
 *   v2/CommandExecutionRequestApprovalResponse  { decision }
 *   v2/FileChangeRequestApprovalResponse        { decision }
 *   v2/PermissionsRequestApprovalResponse       { permissions, scope }
 *   v2/ToolRequestUserInputResponse             { answers }
 *   v2/McpServerElicitationRequestResponse      { action, content, _meta }
 *   v2/DynamicToolCallResponse                  { contentItems, success }
 *   ApplyPatchApprovalResponse / ExecCommandApprovalResponse { decision }
 *
 * `account/chatgptAuthTokens/refresh` and `attestation/generate` have no
 * denial-shaped success value (fabricating credentials/tokens is not an
 * option), so they are answered with a JSON-RPC error.
 */
export const HEADLESS_REJECTION =
  "DeepSeek Harness runs Codex non-interactively; this request was declined. Retry with a narrower scope or fewer permissions.";

const UNSUPPORTED = {
  "account/chatgptAuthTokens/refresh":
    "DeepSeek Harness does not manage ChatGPT auth tokens; run `codex login` yourself.",
  "attestation/generate":
    "DeepSeek Harness does not provide client attestation tokens (requestAttestation is disabled)."
};

/**
 * @param {{ method?: string }} message
 * @returns {{ result: unknown } | { error: { code: number; message: string } }}
 */
export function respondToServerRequest(message) {
  const method = String(message?.method ?? "");
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { result: { decision: "decline" } };
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "item/permissions/requestApproval":
      // No additional permissions are granted; no decision field exists.
      return { result: { permissions: {}, scope: "turn" } };
    case "item/tool/requestUserInput":
      // Do not fabricate user answers; report the absence of answers.
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null } };
    case "item/tool/call":
      return {
        result: {
          success: false,
          contentItems: [{ type: "inputText", text: "Client tool unavailable in DeepSeek Harness." }]
        }
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { result: { decision: { denied: { rejection: HEADLESS_REJECTION } } } };
    default:
      if (UNSUPPORTED[method]) {
        return { error: { code: -32601, message: UNSUPPORTED[method] } };
      }
      return {
        error: {
          code: -32601,
          message: `Unsupported Codex server request from DeepSeek Harness: ${method || "(missing method)"}`
        }
      };
  }
}

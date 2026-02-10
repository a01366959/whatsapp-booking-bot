/*
  adapters/voice.js

  Voice adapter skeleton for Twilio Media Streams. This file outlines the
  streaming entry points and state machine needed for an interruptible
  voice experience.

  NOTE: This is a scaffold only — implementing a production-ready media
  streams flow requires a WebSocket server and real-time STT/TTS integration.
*/

export function createVoiceAdapter({ agentCore, createWebSocketServer, stt, tts, logger }) {
  if (!agentCore) throw new Error("agentCore is required");

  // Example: register a WebSocket route handler for /voice/stream
  function attachToServer(app) {
    // This is a placeholder. The actual implementation must accept Twilio
    // media stream events, decode audio, send audio frames to STT, and
    // forward transcripts to agentCore.handleStreamChunk.
    logger?.info?.("Voice adapter attached — implement WebSocket handling here");
  }

  return { attachToServer };
}

export default { createVoiceAdapter };

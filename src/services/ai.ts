import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { config } from "../config.js";
import {
  TriageResult,
  TriageResultSchema,
  DeepReviewResult,
  DeepReviewResultSchema,
} from "../schemas/review.js";
import { safeParseJson } from "./json-repair.js";

export const ai = new GoogleGenAI({
  vertexai: true,
  project: config.GOOGLE_CLOUD_PROJECT,
  location: config.GOOGLE_CLOUD_LOCATION,
});

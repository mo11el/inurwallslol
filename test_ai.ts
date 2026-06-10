import { createClient } from "@insforge/sdk";
import dotenv from "dotenv";

dotenv.config();

const insforge = createClient({
  baseUrl: process.env.INSFORGE_URL!,
  anonKey: process.env.INSFORGE_ANON_KEY!,
});

async function main() {
  try {
    const resp = await insforge.ai.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "" }, // empty
        { role: "user", content: "Yes" }
      ],
    });
    console.log("Success:", resp.choices?.[0]?.message?.content);
  } catch (err) {
    console.error("Error:", err);
  }
}
main();

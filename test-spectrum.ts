import 'dotenv/config';
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: "602a8669-d96f-45c7-88c9-0b7a7eea4743",
  projectSecret: "owJInc8MvDcoj3jXJqrKFHL1FroCtVqVdFxi_Mr0Jt8",
  providers: [imessage.config()],
});

console.log("Spectrum initialized. Listening for messages...");
for await (const [space, message] of app.messages) {
  console.log("Message received!", Object.keys(message));
  console.log(message);
}

import 'dotenv/config';
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

async function main() {
  const app = await Spectrum({
    projectId: "602a8669-d96f-45c7-88c9-0b7a7eea4743",
    projectSecret: "owJInc8MvDcoj3jXJqrKFHL1FroCtVqVdFxi_Mr0Jt8",
    providers: [imessage.config()],
  });

  console.log("App methods:", Object.getOwnPropertyNames(app));
  
  for await (const [space, message] of app.messages) {
    console.log("Space methods:", Object.getOwnPropertyNames(space));
    console.log("Space proto:", Object.getOwnPropertyNames(Object.getPrototypeOf(space)));
    console.log("Message methods:", Object.getOwnPropertyNames(message));
    console.log("Message proto:", Object.getOwnPropertyNames(Object.getPrototypeOf(message)));
    break; // only need one
  }
}
main();

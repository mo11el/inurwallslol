import 'dotenv/config';
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

async function main() {
  const app = await Spectrum({
    projectId: "602a8669-d96f-45c7-88c9-0b7a7eea4743",
    projectSecret: "owJInc8MvDcoj3jXJqrKFHL1FroCtVqVdFxi_Mr0Jt8",
    providers: [imessage.config()],
  });

  console.log("app.send:", app.send.toString());
  process.exit(0);
}
main();

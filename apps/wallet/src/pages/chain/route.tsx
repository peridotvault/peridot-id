import { Receive } from "./Receive";
import { Send } from "./Send";
import { Swap } from "./Swap";

export const chainPages = {
  send: Send,
  receive: Receive,
  swap: Swap,
};

import { IsString, Length } from "class-validator";
import { WalletCreate } from "@antigane/types";

export class CreateWalletDto implements WalletCreate {
  @IsString()
  @Length(1, 64)
  address!: string;
}

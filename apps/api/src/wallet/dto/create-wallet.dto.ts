import { IsString, Length } from "class-validator";

export class CreateWalletDto {
  @IsString()
  @Length(1, 64)
  address!: string;
}

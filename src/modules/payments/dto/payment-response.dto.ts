import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString } from 'class-validator';
import { AuditFieldsDto } from '../../../common/schemas/shared-audit-fields.schema';

export class PaymentResponseDto extends AuditFieldsDto {
  @ApiProperty({ description: 'Payment amount in base currency', example: '150.00' })
  @IsString()
  amount!: string;

  @ApiProperty({ description: 'Currency code', example: 'USDC' })
  @IsString()
  currency!: string;
}
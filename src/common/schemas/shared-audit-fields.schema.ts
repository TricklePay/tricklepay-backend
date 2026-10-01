
import { ApiProperty } from '@nestjs/swagger';
import { IsDate, IsString } from 'class-validator';

export class AuditFieldsDto {
  @ApiProperty({ description: 'Unique identifier', example: 'uuid-string' })
  @IsString()
  id!: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-09-29T15:39:00Z' })
  @IsDate()
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp', example: '2026-09-29T15:39:00Z' })
  @IsDate()
  updatedAt!: Date;
}
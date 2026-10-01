
import { 
  InternalServerErrorException, 
  NotFoundException, 
  BadRequestException, 
  HttpException 
} from '@nestjs/common';

/**
 * Wraps database repository operations to normalize errors into a consistent shape.
 */
export async function wrapRepositoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    // If it's already an HttpException, rethrow directly
    if (error instanceof HttpException) {
      throw error;
    }

    // Handle standard Prisma / DB error codes
    if (error.code === 'P2025') {
      throw new NotFoundException('Requested record not found in database.');
    }
    if (error.code === 'P2002') {
      const target = error.meta?.target ? ` (${error.meta.target})` : '';
      throw new BadRequestException(`Unique constraint violation${target}.`);
    }

    // Fallback wrapper for unexpected database errors
    throw new InternalServerErrorException(
      `Database operation failed: ${error.message || 'Unknown error'}`
    );
  }
}
# Database Connection Pool Configuration

The backend uses Prisma Client to connect to PostgreSQL, which maintains a connection pool for efficient database access. Understanding and configuring this pool is essential for production deployments, especially on shared or resource-constrained databases.

## Pool Settings

Prisma reads connection pool settings from query parameters appended to `DATABASE_URL`:

### `connection_limit`

Maximum number of database connections in the pool.

- **Default**: `num_physical_cpus * 2 + 1` (Prisma's formula)
- **Recommended**: Match your database's `max_connections` capacity
- **Example for small database**: `connection_limit=5`

### `pool_timeout`

Maximum time (in seconds) to wait for an available connection before failing.

- **Default**: `10` seconds
- **Recommended**: Keep at 10 seconds or slightly higher for high-traffic deployments
- **Example**: `pool_timeout=15`

## Configuration

### Docker Compose Database

The `docker-compose.yml` database uses PostgreSQL's default `max_connections=100`. A single backend instance with the Prisma default pool size (typically 9-17 connections depending on CPU count) will work fine.

For multiple backend instances or when sharing the database:

```bash
DATABASE_URL="postgresql://tricklepay:tricklepay@localhost:5432/tricklepay?connection_limit=10&pool_timeout=10"
```

### Shared or Small Databases

If your database has limited connection capacity (e.g., hobby-tier cloud databases often cap at 20-25 connections):

```bash
# Reserve 5 connections for each backend instance, allowing 4 instances on a 20-connection database
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=5&pool_timeout=10"
```

### High-Traffic Deployments

For databases that can handle more connections and high request volumes:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20&pool_timeout=15"
```

## Validation

The backend validates `connection_limit` and `pool_timeout` at startup. Invalid values cause immediate failure with a clear error message:

- Both must be positive integers
- Non-integer values (like `5.5`) are rejected
- Zero or negative values are rejected
- Helpful error messages include configuration examples

```bash
# This will fail at startup:
DATABASE_URL="postgresql://user:pass@localhost/db?connection_limit=0"

# Error: DATABASE_URL connection_limit must be a positive integer, got "0".
# Example: postgresql://user:pass@host/db?connection_limit=10
```

## Monitoring

Watch for these signs that your pool is undersized:

- Slow queries appearing only under load (queries waiting for connections)
- `database query exceeded its 5000ms bound` errors when the database itself is fast
- `P1001` or `P1002` Prisma errors during high traffic

## Best Practices

1. **Start conservative**: Begin with a small `connection_limit` and increase if needed
2. **Leave headroom**: Don't allocate all database connections to the backend; reserve some for admin access and other services
3. **Match your deployment**:
   - Single instance: Prisma's default is usually fine
   - Multiple instances: Divide max_connections across instances
   - Shared database: Coordinate limits with other applications
4. **Test under load**: Validate your settings with realistic traffic patterns before production

## Further Reading

- [Prisma Connection Management](https://www.prisma.io/docs/concepts/components/prisma-client/working-with-prismaclient/connection-management)
- [PostgreSQL max_connections](https://www.postgresql.org/docs/current/runtime-config-connection.html)

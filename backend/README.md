# Restaurant Supabase Backend

This backend connects your restaurant website to Supabase PostgreSQL database using `@supabase/supabase-js`.

## Setup & Running

1. **Environment Variables**:
   Configured in `backend/.env`:
   - `SUPABASE_URL`: Your Supabase Project URL (`https://tnfgvgzlppgutjeweima.supabase.co`)
   - `SUPABASE_ANON_KEY`: Publishable key for client-safe operations
   - `SUPABASE_SERVICE_ROLE_KEY`: Service key for admin backend operations
   - `ADMIN_KEY`: Generated random hex key for administrative access
   - `PORT`: 3000

2. **Start Server**:
   ```bash
   cd backend
   npm start
   ```
   Or for auto-reload during development:
   ```bash
   npm run dev
   ```

3. **Database Schema (Supabase SQL Editor)**:
   Open your Supabase Dashboard -> **SQL Editor** -> run the contents of [schema.sql](file:///c:/Users/Dell/Downloads/Restaurant/backend/schema.sql) to create:
   - `orders` table (with RLS policies for order logging)
   - `todos` table (matching the Supabase quickstart)

## Endpoints

- `GET /api/health` - Verify server and Supabase connectivity
- `GET /api/todos` - Retrieve test todos
- `POST /api/orders` - Save an order directly to Supabase
- `GET /api/admin/orders` - View all orders (requires header `x-admin-key: <ADMIN_KEY>`)

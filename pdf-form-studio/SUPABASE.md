# חשבונות משתמשים בענן — הקמה חד־פעמית (Supabase)

פילו עובד כולו בדפדפן. כדי שכל עובד יתחבר עם אימייל וסיסמה ויקבל את
הנתונים וההיסטוריה שלו בכל מחשב, צריך שרת קטן אחד לחברה. אנחנו משתמשים
ב‑Supabase (חינמי בנפח של משרד): פרויקט אחד לחברה, כל משתמש מבודד בתוכו.

## 1. פרויקט (5 דקות)
1. https://supabase.com → Sign up → **New project**. שם: `fillo`. אזור: `eu-central-1` (פרנקפורט).
2. **Settings → API**: העתיקו את **Project URL** ואת **anon public key**.
3. **Authentication → Providers → Email**: אם רוצים שעובדים ייכנסו מיד בלי מייל אימות —
   כבו את **Confirm email**. (אפשר להשאיר דלוק; אז כל עובד מאשר מייל פעם אחת.)
4. **Authentication → Sign In / Providers**: אם רוצים שרק אתם תפתחו חשבונות —
   כבו **Allow new users to sign up** אחרי שיצרתם את החשבונות של העובדים
   (או תשאירו פתוח ותשלחו להם את הקישור).

## 2. טבלה + הרשאות (הדבקה אחת)
**SQL Editor → New query** → הדביקו והריצו:

```sql
-- one row per user: everything the app keeps locally, mirrored
create table if not exists public.vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.vaults enable row level security;

create policy "own vault: read"   on public.vaults for select using (auth.uid() = user_id);
create policy "own vault: insert" on public.vaults for insert with check (auth.uid() = user_id);
create policy "own vault: update" on public.vaults for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own vault: delete" on public.vaults for delete using (auth.uid() = user_id);

-- the documents themselves (history, certificate formats, appendices):
-- a PRIVATE bucket, one folder per user
insert into storage.buckets (id, name, public, file_size_limit)
  values ('docs', 'docs', false, 26214400)
  on conflict (id) do update set public = false, file_size_limit = 26214400;

create policy "own docs: read"   on storage.objects for select
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs: write"  on storage.objects for insert
  with check (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs: update" on storage.objects for update
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs: delete" on storage.objects for delete
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
```

## 3. חיבור לפילו
שלחו לי את **Project URL** ואת **anon key** (המפתח הזה ציבורי מעצם טבעו —
כל ההגנה היא במדיניות ההרשאות למעלה), ואני צורב אותם ב‑`index.html`:

```js
window.PFS_SUPABASE = { url: 'https://xxxx.supabase.co', anonKey: 'eyJ…', requireLogin: true };
```

`requireLogin: true` = פילו נפתח במסך התחברות, וכל עובד עובד רק בתוך החשבון שלו.
לבדיקה לפני הצריבה: הגדרות → חשבון → "הפעלה (למפעיל)" — מדביקים שם את שני הערכים.

## 4. מחלקת תעודות — מאגר משותף (הדבקה אחת)
כשכמה עובדים מנפיקים תעודות, כל אחד נכנס עם המשתמש שלו, ולמחלקה יש
**מאגר תעודות אחד, מספור תעודות אחד ופורמטים משותפים**. הנתונים האישיים
(פרופיל, חתימות, היסטוריה) נשארים אישיים. רק חברי המחלקה רואים את המאגר.

**SQL Editor → New query** → הדביקו והריצו:

```sql
-- ===== certificates department: shared archive, numbering, formats =====
create table if not exists public.dept_members (
  email text primary key check (email = lower(email)),
  role text not null default 'member' check (role in ('admin', 'member')),
  added_by text,
  added_at timestamptz not null default now()
);
create table if not exists public.dept_batches (
  id text primary key,
  data jsonb not null,
  created_by text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.dept_formats (
  id text primary key,
  name text not null,
  created_by text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at timestamptz not null default now()
);
create table if not exists public.dept_counters (
  name text primary key,
  value bigint not null default 0
);
alter table public.dept_members  enable row level security;
alter table public.dept_batches  enable row level security;
alter table public.dept_formats  enable row level security;
alter table public.dept_counters enable row level security;   -- no policies: reached only through dept_next()

create or replace function public.dept_me() returns text language sql stable as
$$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;
create or replace function public.dept_is_member() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.dept_members where email = public.dept_me()) $$;
create or replace function public.dept_is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.dept_members where email = public.dept_me() and role = 'admin') $$;

-- who is in the department: members see it, only the admin changes it
create policy "dept members: read"   on public.dept_members for select using (public.dept_is_member());
create policy "dept members: add"    on public.dept_members for insert with check (public.dept_is_admin());
create policy "dept members: change" on public.dept_members for update using (public.dept_is_admin());
create policy "dept members: remove" on public.dept_members for delete using (public.dept_is_admin() and email <> public.dept_me());

-- the archive: every member reads and files; a batch is deleted by whoever produced it, or the admin
create policy "dept batches: read"   on public.dept_batches for select using (public.dept_is_member());
create policy "dept batches: file"   on public.dept_batches for insert with check (public.dept_is_member() and created_by = public.dept_me());
create policy "dept batches: refile" on public.dept_batches for update using (public.dept_is_member());
create policy "dept batches: delete" on public.dept_batches for delete using (public.dept_is_admin() or created_by = public.dept_me());

create policy "dept formats: read"   on public.dept_formats for select using (public.dept_is_member());
create policy "dept formats: add"    on public.dept_formats for insert with check (public.dept_is_member());
create policy "dept formats: change" on public.dept_formats for update using (public.dept_is_member());
create policy "dept formats: delete" on public.dept_formats for delete using (public.dept_is_admin() or created_by = public.dept_me());

-- the first person to set the department up becomes its admin
create or replace function public.dept_claim() returns boolean language plpgsql security definer set search_path = public as $$
begin
  if public.dept_me() = '' then return false; end if;
  if exists (select 1 from public.dept_members where role = 'admin') then return public.dept_is_admin(); end if;
  insert into public.dept_members (email, role, added_by) values (public.dept_me(), 'admin', public.dept_me())
    on conflict (email) do update set role = 'admin';
  return true;
end $$;

-- certificate numbers: ONE atomic counter, so two clerks never get the same number
create or replace function public.dept_next(p_name text, p_count int) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not public.dept_is_member() then raise exception 'not a department member'; end if;
  if p_count < 1 or p_count > 5000 then raise exception 'bad count'; end if;
  insert into public.dept_counters (name, value) values (p_name, p_count)
    on conflict (name) do update set value = public.dept_counters.value + excluded.value
    returning value into v;
  return v - p_count + 1;
end $$;

-- numbers already issued before the department existed: the counter never goes below them
create or replace function public.dept_seed(p_name text, p_floor bigint) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not public.dept_is_member() then raise exception 'not a department member'; end if;
  insert into public.dept_counters (name, value) values (p_name, greatest(p_floor, 0))
    on conflict (name) do update set value = greatest(public.dept_counters.value, excluded.value)
    returning value into v;
  return v;
end $$;

-- the department's certificate formats: a shared folder in the private bucket
create policy "dept docs: read"   on storage.objects for select
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = 'dept' and public.dept_is_member());
create policy "dept docs: write"  on storage.objects for insert
  with check (bucket_id = 'docs' and (storage.foldername(name))[1] = 'dept' and public.dept_is_member());
create policy "dept docs: update" on storage.objects for update
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = 'dept' and public.dept_is_member());
```

אחר כך בפילו: **הגדרות → חשבון → מחלקת תעודות → "הקמת מחלקת התעודות — אני
המנהל/ת"**, ומוסיפים שם את המייל של כל עובד. עובד שנכנס עם המשתמש שלו רואה מיד
את המאגר המשותף. מחזורים שהופקו קודם במחשב של המנהל עוברים למאגר המחלקה לבד.

## מה נשמר לכל משתמש
- כל מה שפילו לומד: פרטי המכללה/פרופילים, מיקומי שדות לכל טופס, חתימות וחותמות,
  קורסים ותיקי קורס, יומן התעודות ומספור התעודות.
- **היסטוריית העבודה**: המסמכים שנפתחו (עם המילוי שלהם), פורמטי התעודות במדף,
  והנספחים המקושרים — הקבצים עצמם בתיקייה פרטית של המשתמש.
- התנתקות מנקה את המחשב המשותף; התחברות במחשב אחר מחזירה הכול.

## עלות
התוכנית החינמית: 500MB מסד נתונים, 1GB קבצים, 50,000 משתמשים פעילים בחודש.
משרד עם עשרות עובדים ומאות מסמכים לא מתקרב לזה. אם יעברו — התוכנית הבאה ~$25/חודש.

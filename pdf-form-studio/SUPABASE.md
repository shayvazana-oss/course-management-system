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

## מה נשמר לכל משתמש
- כל מה שפילו לומד: פרטי המכללה/פרופילים, מיקומי שדות לכל טופס, חתימות וחותמות,
  קורסים ותיקי קורס, יומן התעודות ומספור התעודות.
- **היסטוריית העבודה**: המסמכים שנפתחו (עם המילוי שלהם), פורמטי התעודות במדף,
  והנספחים המקושרים — הקבצים עצמם בתיקייה פרטית של המשתמש.
- התנתקות מנקה את המחשב המשותף; התחברות במחשב אחר מחזירה הכול.

## עלות
התוכנית החינמית: 500MB מסד נתונים, 1GB קבצים, 50,000 משתמשים פעילים בחודש.
משרד עם עשרות עובדים ומאות מסמכים לא מתקרב לזה. אם יעברו — התוכנית הבאה ~$25/חודש.

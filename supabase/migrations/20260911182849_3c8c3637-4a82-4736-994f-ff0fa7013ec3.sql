-- Roles enum
CREATE TYPE public.app_role AS ENUM ('admin','supervisor','loading_supervisor','dipping_supervisor','qc_inspector');

-- Profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  username text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User roles (separate table to avoid privilege escalation)
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer role checker
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- Beams (shared production data, jsonb for flexible shape)
CREATE TABLE public.beams (
  beam_no text PRIMARY KEY,
  status text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.beams TO authenticated;
GRANT ALL ON public.beams TO service_role;
ALTER TABLE public.beams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.beams REPLICA IDENTITY FULL;

-- Audit log
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "user update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "admin insert profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "admin delete profile" ON public.profiles FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "admin manage roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "auth read beams" ON public.beams FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin delete beams" ON public.beams FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE POLICY "admin delete audit" ON public.audit_log FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- Trigger: on signup, create profile; first user becomes admin
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _is_first boolean;
  _meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
BEGIN
  INSERT INTO public.profiles (id, email, full_name, username)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(_meta->>'full_name', NEW.email),
    COALESCE(_meta->>'username', split_part(NEW.email,'@',1))
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT NOT EXISTS(SELECT 1 FROM public.user_roles) INTO _is_first;

  IF _is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.beams;
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_roles;

-- Function grants
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;

-- audit_log: admin-only read; attributed insert
CREATE POLICY "admin read audit" ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- profiles / roles read scoping
CREATE POLICY "read own or admin profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "read own or admin role" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'::public.app_role));

-- Dipping sequence validation
CREATE OR REPLACE FUNCTION public.validate_beam_dipping_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  d jsonb := COALESCE(NEW.data, '{}'::jsonb);
  ts_imm_start timestamptz;
  ts_imm_end   timestamptz;
  ts_react_end timestamptz;
  ts_with_end  timestamptz;
  bypass boolean := COALESCE((d->>'bypass_sequence_check')::boolean, false);
BEGIN
  IF bypass AND public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  BEGIN
    ts_imm_start := NULLIF(d->>'immersion_start','')::timestamptz;
    ts_imm_end   := NULLIF(d->>'immersion_end','')::timestamptz;
    ts_react_end := NULLIF(d->>'reaction_end','')::timestamptz;
    ts_with_end  := NULLIF(d->>'withdrawal_end','')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid dipping timestamp format on beam %', NEW.beam_no;
  END;

  IF ts_imm_end IS NOT NULL AND ts_imm_start IS NULL THEN
    RAISE EXCEPTION 'Beam %: Immersion End requires Immersion Start', NEW.beam_no;
  END IF;
  IF ts_react_end IS NOT NULL AND (ts_imm_start IS NULL OR ts_imm_end IS NULL) THEN
    RAISE EXCEPTION 'Beam %: Reaction End requires Immersion Start and Immersion End', NEW.beam_no;
  END IF;
  IF ts_with_end IS NOT NULL AND (ts_imm_start IS NULL OR ts_imm_end IS NULL OR ts_react_end IS NULL) THEN
    RAISE EXCEPTION 'Beam %: Withdrawal End requires all previous dipping steps', NEW.beam_no;
  END IF;

  IF ts_imm_end IS NOT NULL AND ts_imm_end < ts_imm_start THEN
    RAISE EXCEPTION 'Beam %: Immersion End (%) must be on/after Immersion Start (%)', NEW.beam_no, ts_imm_end, ts_imm_start;
  END IF;
  IF ts_react_end IS NOT NULL AND ts_react_end < ts_imm_end THEN
    RAISE EXCEPTION 'Beam %: Reaction End (%) must be on/after Immersion End (%)', NEW.beam_no, ts_react_end, ts_imm_end;
  END IF;
  IF ts_with_end IS NOT NULL AND ts_with_end < ts_react_end THEN
    RAISE EXCEPTION 'Beam %: Withdrawal End (%) must be on/after Reaction End (%)', NEW.beam_no, ts_with_end, ts_react_end;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_beam_dipping_sequence ON public.beams;
CREATE TRIGGER trg_validate_beam_dipping_sequence
BEFORE INSERT OR UPDATE ON public.beams
FOR EACH ROW
EXECUTE FUNCTION public.validate_beam_dipping_sequence();

REVOKE EXECUTE ON FUNCTION public.validate_beam_dipping_sequence() FROM PUBLIC, anon, authenticated;
CREATE TABLE public.micron_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix text NOT NULL,
  thickness_min numeric NOT NULL CHECK (thickness_min >= 0),
  thickness_max numeric NULL,
  coating_required integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_by uuid NULL,
  updated_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT micron_rules_max_ge_min CHECK (thickness_max IS NULL OR thickness_max >= thickness_min)
);

CREATE UNIQUE INDEX micron_rules_unique_range
  ON public.micron_rules (upper(prefix), thickness_min, COALESCE(thickness_max, 99999));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.micron_rules TO authenticated;
GRANT ALL ON public.micron_rules TO service_role;

ALTER TABLE public.micron_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "micron_rules read for authenticated"
  ON public.micron_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "micron_rules insert admin"
  ON public.micron_rules FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "micron_rules update admin"
  ON public.micron_rules FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "micron_rules delete admin"
  ON public.micron_rules FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.touch_micron_rules_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_micron_rules_touch
  BEFORE UPDATE ON public.micron_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_micron_rules_updated_at();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='part_prefix_micron') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.part_prefix_micron';
  END IF;
END $$;
DROP TABLE IF EXISTS public.part_prefix_micron CASCADE;

CREATE POLICY "manager read audit"
  ON public.audit_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'manager'::public.app_role));

ALTER TABLE public.beams ADD COLUMN IF NOT EXISTS material_type text;
ALTER TABLE public.beams ADD COLUMN IF NOT EXISTS surface_condition text;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

DROP POLICY IF EXISTS "admin read database_export_03_07_26" ON storage.objects;
DROP POLICY IF EXISTS "admin insert database_export_03_07_26" ON storage.objects;
DROP POLICY IF EXISTS "admin update database_export_03_07_26" ON storage.objects;
DROP POLICY IF EXISTS "admin delete database_export_03_07_26" ON storage.objects;

CREATE POLICY "admin read database_export_03_07_26"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'database_export_03_07_26' AND public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "admin insert database_export_03_07_26"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'database_export_03_07_26' AND public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "admin update database_export_03_07_26"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'database_export_03_07_26' AND public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (bucket_id = 'database_export_03_07_26' AND public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "admin delete database_export_03_07_26"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'database_export_03_07_26' AND public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.enforce_module_access_beams()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  ma jsonb;
  perms jsonb;
  ret_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN ret_row := OLD; ELSE ret_row := NEW; END IF;
  IF uid IS NULL THEN RETURN ret_row; END IF;
  IF public.has_role(uid, 'admin'::public.app_role) THEN RETURN ret_row; END IF;

  SELECT value INTO ma FROM public.app_settings WHERE key = 'moduleAccess';
  IF ma IS NULL THEN RETURN ret_row; END IF;
  perms := ma -> uid::text;
  IF perms IS NULL THEN RETURN ret_row; END IF;

  IF COALESCE((perms->>'readOnly')::boolean, false) THEN
    RAISE EXCEPTION 'Forbidden: admin has restricted your account to read-only';
  END IF;
  IF COALESCE((perms->>'exportOnly')::boolean, false) THEN
    RAISE EXCEPTION 'Forbidden: admin has restricted your account to export-only';
  END IF;

  RETURN ret_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_module_access_beams() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_module_access_beams_iud ON public.beams;
CREATE TRIGGER enforce_module_access_beams_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public.beams
  FOR EACH ROW EXECUTE FUNCTION public.enforce_module_access_beams();

DROP TRIGGER IF EXISTS enforce_module_access_beam_materials_iud ON public.beam_materials;
CREATE TRIGGER enforce_module_access_beam_materials_iud
  BEFORE INSERT OR UPDATE OR DELETE ON public.beam_materials
  FOR EACH ROW EXECUTE FUNCTION public.enforce_module_access_beams();

CREATE OR REPLACE FUNCTION public.validate_beam_status_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  is_privileged boolean;
BEGIN
  is_privileged :=
    public.has_role(uid, 'admin'::public.app_role)
    OR public.has_role(uid, 'supervisor'::public.app_role)
    OR public.has_role(uid, 'shift_supervisor'::public.app_role)
    OR public.has_role(uid, 'manager'::public.app_role);

  IF is_privileged THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT public.has_role(uid, 'loading_supervisor'::public.app_role) THEN
      RAISE EXCEPTION 'Forbidden: only loading roles may create beams';
    END IF;
    IF NEW.status <> 'LOADED' THEN
      RAISE EXCEPTION 'Forbidden: new beams must start in LOADED status';
    END IF;
    RETURN NEW;
  END IF;

  IF public.has_role(uid, 'loading_supervisor'::public.app_role) THEN
    IF OLD.status <> 'LOADED' OR NEW.status <> 'LOADED' THEN
      RAISE EXCEPTION 'Forbidden: loading role can only modify LOADED beams';
    END IF;
    RETURN NEW;
  END IF;

  IF public.has_role(uid, 'dipping_supervisor'::public.app_role) THEN
    IF OLD.status NOT IN ('LOADED','DIPPING','QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: dipping role cannot modify beam in status %', OLD.status;
    END IF;
    IF NEW.status = 'LOADED' THEN
      IF OLD.status <> 'DIPPING' THEN
        RAISE EXCEPTION 'Forbidden: dipping role can only revert DIPPING beams to LOADED';
      END IF;
      IF NEW.data->>'immersion_start' IS NOT NULL
         OR NEW.data->>'immersion_end' IS NOT NULL
         OR NEW.data->>'reaction_end' IS NOT NULL
         OR NEW.data->>'withdrawal_end' IS NOT NULL
         OR NEW.data->>'immersion_duration' IS NOT NULL
         OR NEW.data->>'reaction_duration' IS NOT NULL
         OR NEW.data->>'withdrawal_duration' IS NOT NULL THEN
        RAISE EXCEPTION 'Forbidden: revert to LOADED requires clearing dipping phase fields';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status NOT IN ('DIPPING','QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: dipping role cannot set status to %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF public.has_role(uid, 'qc_inspector'::public.app_role) THEN
    IF OLD.status NOT IN ('QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: QC role cannot modify beam in status %', OLD.status;
    END IF;
    IF NEW.status NOT IN ('QC_PENDING','COMPLETED') THEN
      RAISE EXCEPTION 'Forbidden: QC role cannot set status to %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Forbidden: caller has no role authorized to modify beams';
END;
$$;

REVOKE ALL ON FUNCTION public.validate_beam_status_transition() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS beams_validate_status_transition ON public.beams;
DROP TRIGGER IF EXISTS trg_validate_beam_status ON public.beams;
CREATE TRIGGER trg_validate_beam_status
BEFORE INSERT OR UPDATE ON public.beams
FOR EACH ROW EXECUTE FUNCTION public.validate_beam_status_transition();

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['beams','beam_materials','micron_rules','audit_log','app_settings','profiles','user_roles','active_sessions'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=tbl AND c.relkind='r')
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=tbl) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "authenticated can subscribe to allowed topics" ON realtime.messages';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated can read app realtime topics" ON realtime.messages';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated can send app realtime topics" ON realtime.messages';
  EXECUTE $p$CREATE POLICY "Authenticated can read app realtime topics"
    ON realtime.messages FOR SELECT TO authenticated
    USING (
      realtime.topic() LIKE 'sync:beams:%'
      OR realtime.topic() LIKE 'sync:beam_materials:%'
      OR realtime.topic() LIKE 'sync:micron_rules:%'
      OR realtime.topic() LIKE 'sync:audit_log:%'
      OR realtime.topic() LIKE 'sync:part_prefix_micron:%'
      OR realtime.topic() = 'sync:users'
      OR realtime.topic() LIKE 'settings:%'
      OR realtime.topic() LIKE ('active_sessions:' || auth.uid()::text || ':%')
      OR realtime.topic() LIKE 'realtime:public:beams%'
      OR realtime.topic() LIKE 'realtime:public:beam_materials%'
      OR realtime.topic() LIKE 'realtime:public:micron_rules%'
      OR realtime.topic() LIKE 'realtime:public:audit_log%'
      OR realtime.topic() LIKE 'realtime:public:app_settings%'
      OR realtime.topic() LIKE 'realtime:public:profiles%'
      OR realtime.topic() LIKE 'realtime:public:user_roles%'
      OR realtime.topic() LIKE 'realtime:public:active_sessions%'
    )$p$;
  EXECUTE $p$CREATE POLICY "Authenticated can send app realtime topics"
    ON realtime.messages FOR INSERT TO authenticated
    WITH CHECK (
      realtime.topic() LIKE 'sync:beams:%'
      OR realtime.topic() LIKE 'sync:beam_materials:%'
      OR realtime.topic() LIKE 'sync:micron_rules:%'
      OR realtime.topic() LIKE 'sync:audit_log:%'
      OR realtime.topic() LIKE 'sync:part_prefix_micron:%'
      OR realtime.topic() = 'sync:users'
      OR realtime.topic() LIKE 'settings:%'
      OR realtime.topic() LIKE ('active_sessions:' || auth.uid()::text || ':%')
    )$p$;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'realtime.messages policies skipped: %', SQLERRM;
END $$;
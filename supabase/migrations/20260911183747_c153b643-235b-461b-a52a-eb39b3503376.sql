DROP POLICY IF EXISTS "auth read settings" ON public.app_settings;
CREATE POLICY "role read settings" ON public.app_settings
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
);

DROP POLICY IF EXISTS "auth read beams" ON public.beams;
CREATE POLICY "role read beams" ON public.beams
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
);

DROP POLICY IF EXISTS "auth read beam_materials" ON public.beam_materials;
CREATE POLICY "role read beam_materials" ON public.beam_materials
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
);

DROP POLICY IF EXISTS "micron_rules read for authenticated" ON public.micron_rules;
CREATE POLICY "role read micron_rules" ON public.micron_rules
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::public.app_role)
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'loading_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role)
  OR public.has_role(auth.uid(), 'qc_inspector'::public.app_role)
);

DROP POLICY IF EXISTS "role update beams attributed" ON public.beams;
CREATE POLICY "role update beams attributed"
  ON public.beams FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
    OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR (public.has_role(auth.uid(), 'loading_supervisor'::public.app_role) AND status = 'LOADED')
    OR (public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role) AND status = ANY (ARRAY['LOADED','DIPPING','QC_PENDING','COMPLETED']))
    OR (public.has_role(auth.uid(), 'qc_inspector'::public.app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
  )
  WITH CHECK (
    (updated_by IS NULL OR updated_by = auth.uid())
    AND (
      public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'shift_supervisor'::public.app_role)
      OR public.has_role(auth.uid(), 'manager'::public.app_role)
      OR (public.has_role(auth.uid(), 'loading_supervisor'::public.app_role) AND status = 'LOADED')
      OR (public.has_role(auth.uid(), 'dipping_supervisor'::public.app_role) AND status = ANY (ARRAY['DIPPING','QC_PENDING','COMPLETED']))
      OR (public.has_role(auth.uid(), 'qc_inspector'::public.app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
    )
  );

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _is_first boolean;
  _meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
BEGIN
  BEGIN
    INSERT INTO public.profiles (id, email, full_name, username)
    VALUES (
      NEW.id, NEW.email,
      COALESCE(_meta->>'full_name', NEW.email),
      COALESCE(_meta->>'username', split_part(NEW.email,'@',1))
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'handle_new_user profile insert failed for %: %', NEW.id, SQLERRM;
  END;

  BEGIN
    SELECT NOT EXISTS(SELECT 1 FROM public.user_roles) INTO _is_first;
    IF _is_first THEN
      INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin') ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'handle_new_user first-user role insert failed for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END $function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.micron_rules ADD COLUMN IF NOT EXISTS local_coating_required numeric;

ALTER TABLE public.beams
  ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_by uuid,
  ADD COLUMN IF NOT EXISTS enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS enabled_by uuid;

CREATE TABLE public.mlr_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'dipping_total_time',
  coefficients jsonb NOT NULL DEFAULT '{}'::jsonb,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  r2 numeric,
  coating_r2 numeric,
  sample_rows integer NOT NULL DEFAULT 0,
  source_filename text,
  trained_by uuid,
  trained_by_name text,
  model_type text NOT NULL DEFAULT 'mlr',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mlr_models_name_type_uidx ON public.mlr_models (name, model_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mlr_models TO authenticated;
GRANT ALL ON public.mlr_models TO service_role;
ALTER TABLE public.mlr_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role read mlr_models" ON public.mlr_models
FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'supervisor'::app_role) OR has_role(auth.uid(), 'shift_supervisor'::app_role)
  OR has_role(auth.uid(), 'loading_supervisor'::app_role) OR has_role(auth.uid(), 'dipping_supervisor'::app_role)
  OR has_role(auth.uid(), 'qc_inspector'::app_role)
);
CREATE POLICY "admin insert mlr_models" ON public.mlr_models
FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "admin update mlr_models" ON public.mlr_models
FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "admin delete mlr_models" ON public.mlr_models
FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_mlr_models_touch
BEFORE UPDATE ON public.mlr_models
FOR EACH ROW EXECUTE FUNCTION public.touch_micron_rules_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOR i IN 1..5 LOOP
    t := 'new_beams_' || i;
    EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I (LIKE public.beams INCLUDING ALL)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format($p$
      CREATE POLICY "role read %1$s" ON public.%1$I
      FOR SELECT TO authenticated
      USING (
        has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
        OR has_role(auth.uid(), 'supervisor'::app_role) OR has_role(auth.uid(), 'shift_supervisor'::app_role)
        OR has_role(auth.uid(), 'loading_supervisor'::app_role) OR has_role(auth.uid(), 'dipping_supervisor'::app_role)
        OR has_role(auth.uid(), 'qc_inspector'::app_role)
      )$p$, t);

    EXECUTE format($p$
      CREATE POLICY "role insert %1$s attributed" ON public.%1$I
      FOR INSERT TO authenticated
      WITH CHECK (
        (auth.uid() IS NOT NULL)
        AND ((updated_by IS NULL) OR (updated_by = auth.uid()))
        AND (
          has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'supervisor'::app_role)
          OR has_role(auth.uid(), 'shift_supervisor'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
          OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
        )
      )$p$, t);

    EXECUTE format($p$
      CREATE POLICY "role update %1$s attributed" ON public.%1$I
      FOR UPDATE TO authenticated
      USING (
        has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'supervisor'::app_role)
        OR has_role(auth.uid(), 'shift_supervisor'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
        OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
        OR (has_role(auth.uid(), 'dipping_supervisor'::app_role) AND status = ANY (ARRAY['LOADED','DIPPING','QC_PENDING','COMPLETED']))
        OR (has_role(auth.uid(), 'qc_inspector'::app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
      )
      WITH CHECK (
        ((updated_by IS NULL) OR (updated_by = auth.uid()))
        AND (
          has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'supervisor'::app_role)
          OR has_role(auth.uid(), 'shift_supervisor'::app_role) OR has_role(auth.uid(), 'manager'::app_role)
          OR (has_role(auth.uid(), 'loading_supervisor'::app_role) AND status = 'LOADED')
          OR (has_role(auth.uid(), 'dipping_supervisor'::app_role) AND status = ANY (ARRAY['DIPPING','QC_PENDING','COMPLETED']))
          OR (has_role(auth.uid(), 'qc_inspector'::app_role) AND status = ANY (ARRAY['QC_PENDING','COMPLETED']))
        )
      )$p$, t);

    EXECUTE format($p$
      CREATE POLICY "admin delete %1$s" ON public.%1$I
      FOR DELETE TO authenticated
      USING (has_role(auth.uid(), 'admin'::app_role))$p$, t);

    EXECUTE format($p$
      CREATE TRIGGER %1$s_validate_status_transition
      BEFORE INSERT OR UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.validate_beam_status_transition()$p$, t);

    EXECUTE format($p$
      CREATE TRIGGER enforce_module_access_%1$s_iud
      BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.enforce_module_access_beams()$p$, t);

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
  END LOOP;
END $$;

CREATE SEQUENCE IF NOT EXISTS public.beam_shard_seq;

CREATE OR REPLACE FUNCTION public.next_beam_shard()
RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
  SELECT ((nextval('public.beam_shard_seq') - 1) % 5)::int + 1
$$;

REVOKE ALL ON SEQUENCE public.beam_shard_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.beam_shard_seq TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.next_beam_shard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_beam_shard() TO authenticated, service_role;

CREATE TABLE public.user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  device_name text,
  device_type text,
  operating_system text,
  browser text,
  browser_version text,
  app_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_ip text,
  status text NOT NULL DEFAULT 'PENDING',
  approved_by uuid,
  approved_at timestamptz,
  rejected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED','EXPIRED')),
  CONSTRAINT user_devices_unique UNIQUE (user_id, device_id)
);
CREATE INDEX idx_user_devices_user ON public.user_devices(user_id);
CREATE INDEX idx_user_devices_status ON public.user_devices(status);

GRANT SELECT ON public.user_devices TO authenticated;
GRANT ALL ON public.user_devices TO service_role;
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own devices" ON public.user_devices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TABLE public.device_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  email text,
  ip_address text,
  ip_version text,
  device_type text,
  operating_system text,
  browser text,
  browser_version text,
  location text,
  status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dar_status_chk CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CLOSED'))
);
CREATE INDEX idx_dar_status ON public.device_approval_requests(status);
CREATE INDEX idx_dar_user ON public.device_approval_requests(user_id);

GRANT SELECT ON public.device_approval_requests TO authenticated;
GRANT ALL ON public.device_approval_requests TO service_role;
ALTER TABLE public.device_approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read approval requests" ON public.device_approval_requests
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TABLE public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  email text,
  device_id text,
  ip_address text,
  ip_version text,
  user_agent text,
  device_type text,
  operating_system text,
  browser text,
  browser_version text,
  authentication_result text NOT NULL,
  device_status text,
  ip_status text,
  approval_request_id text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_created ON public.login_attempts(created_at DESC);
CREATE INDEX idx_login_attempts_ip ON public.login_attempts(ip_address, created_at DESC);
CREATE INDEX idx_login_attempts_email ON public.login_attempts(email, created_at DESC);

GRANT SELECT ON public.login_attempts TO authenticated;
GRANT ALL ON public.login_attempts TO service_role;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read login attempts" ON public.login_attempts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TABLE public.security_audit_logs (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid,
  admin_id uuid,
  device_id text,
  ip_address text,
  request_id text,
  result text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sal_created ON public.security_audit_logs(created_at DESC);
CREATE INDEX idx_sal_type ON public.security_audit_logs(event_type);

GRANT SELECT ON public.security_audit_logs TO authenticated;
GRANT ALL ON public.security_audit_logs TO service_role;
ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read security audit" ON public.security_audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

ALTER TABLE public.active_sessions ADD COLUMN IF NOT EXISTS device_id text;

CREATE TRIGGER trg_user_devices_touch
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.touch_micron_rules_updated_at();

INSERT INTO public.app_settings (key, value)
VALUES
  ('security.devices', '{"maxDevices":2,"approvalExpiryMinutes":60,"bootstrapAdminDevice":true}'::jsonb),
  ('security.ip', '{"mode":"MONITOR","allowlist":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.beams DROP CONSTRAINT IF EXISTS beams_updated_by_fkey;
ALTER TABLE public.beams ADD CONSTRAINT beams_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_created_by_fkey;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
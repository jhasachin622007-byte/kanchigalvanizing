export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_sessions: {
        Row: {
          device_id: string | null
          device_info: string | null
          session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          device_id?: string | null
          device_info?: string | null
          session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          device_id?: string | null
          device_info?: string | null
          session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          created_at: string
          data: Json
          id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          data: Json
          id?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      beam_materials: {
        Row: {
          beam_no: string
          coating_spec: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decided_by_name: string | null
          defect_remark: string | null
          defect_type: string | null
          id: string
          offered_at: string
          part_no: string | null
          qc_status: string
          quantity: number | null
          route_card_no: string | null
          transaction_id: string
          updated_at: string
        }
        Insert: {
          beam_no: string
          coating_spec?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decided_by_name?: string | null
          defect_remark?: string | null
          defect_type?: string | null
          id?: string
          offered_at?: string
          part_no?: string | null
          qc_status?: string
          quantity?: number | null
          route_card_no?: string | null
          transaction_id: string
          updated_at?: string
        }
        Update: {
          beam_no?: string
          coating_spec?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decided_by_name?: string | null
          defect_remark?: string | null
          defect_type?: string | null
          id?: string
          offered_at?: string
          part_no?: string | null
          qc_status?: string
          quantity?: number | null
          route_card_no?: string | null
          transaction_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      beams: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      device_approval_requests: {
        Row: {
          browser: string | null
          browser_version: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          device_id: string
          device_type: string | null
          email: string | null
          expires_at: string
          id: string
          ip_address: string | null
          ip_version: string | null
          location: string | null
          operating_system: string | null
          reason: string | null
          request_id: string
          status: string
          user_id: string
        }
        Insert: {
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          device_id: string
          device_type?: string | null
          email?: string | null
          expires_at: string
          id?: string
          ip_address?: string | null
          ip_version?: string | null
          location?: string | null
          operating_system?: string | null
          reason?: string | null
          request_id: string
          status?: string
          user_id: string
        }
        Update: {
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          device_id?: string
          device_type?: string | null
          email?: string | null
          expires_at?: string
          id?: string
          ip_address?: string | null
          ip_version?: string | null
          location?: string | null
          operating_system?: string | null
          reason?: string | null
          request_id?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      login_attempts: {
        Row: {
          approval_request_id: string | null
          authentication_result: string
          browser: string | null
          browser_version: string | null
          created_at: string
          device_id: string | null
          device_status: string | null
          device_type: string | null
          email: string | null
          id: string
          ip_address: string | null
          ip_status: string | null
          ip_version: string | null
          operating_system: string | null
          request_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          approval_request_id?: string | null
          authentication_result: string
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          device_id?: string | null
          device_status?: string | null
          device_type?: string | null
          email?: string | null
          id?: string
          ip_address?: string | null
          ip_status?: string | null
          ip_version?: string | null
          operating_system?: string | null
          request_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          approval_request_id?: string | null
          authentication_result?: string
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          device_id?: string | null
          device_status?: string | null
          device_type?: string | null
          email?: string | null
          id?: string
          ip_address?: string | null
          ip_status?: string | null
          ip_version?: string | null
          operating_system?: string | null
          request_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      micron_rules: {
        Row: {
          active: boolean
          coating_required: number
          created_at: string
          id: string
          local_coating_required: number | null
          prefix: string
          thickness_max: number | null
          thickness_min: number
          updated_at: string
          updated_by: string | null
          updated_by_name: string | null
        }
        Insert: {
          active?: boolean
          coating_required: number
          created_at?: string
          id?: string
          local_coating_required?: number | null
          prefix: string
          thickness_max?: number | null
          thickness_min: number
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
        }
        Update: {
          active?: boolean
          coating_required?: number
          created_at?: string
          id?: string
          local_coating_required?: number | null
          prefix?: string
          thickness_max?: number | null
          thickness_min?: number
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
        }
        Relationships: []
      }
      mlr_models: {
        Row: {
          coating_r2: number | null
          coefficients: Json
          created_at: string
          features: Json
          id: string
          model_type: string
          name: string
          r2: number | null
          sample_rows: number
          source_filename: string | null
          trained_by: string | null
          trained_by_name: string | null
          updated_at: string
        }
        Insert: {
          coating_r2?: number | null
          coefficients?: Json
          created_at?: string
          features?: Json
          id?: string
          model_type?: string
          name?: string
          r2?: number | null
          sample_rows?: number
          source_filename?: string | null
          trained_by?: string | null
          trained_by_name?: string | null
          updated_at?: string
        }
        Update: {
          coating_r2?: number | null
          coefficients?: Json
          created_at?: string
          features?: Json
          id?: string
          model_type?: string
          name?: string
          r2?: number | null
          sample_rows?: number
          source_filename?: string | null
          trained_by?: string | null
          trained_by_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      new_beams_1: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      new_beams_2: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      new_beams_3: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      new_beams_4: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      new_beams_5: {
        Row: {
          beam_no: string
          data: Json
          disabled_at: string | null
          disabled_by: string | null
          enabled_at: string | null
          enabled_by: string | null
          is_enabled: boolean
          material_type: string | null
          status: string
          surface_condition: string | null
          transaction_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          beam_no: string
          data: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status: string
          surface_condition?: string | null
          transaction_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          beam_no?: string
          data?: Json
          disabled_at?: string | null
          disabled_by?: string | null
          enabled_at?: string | null
          enabled_by?: string | null
          is_enabled?: boolean
          material_type?: string | null
          status?: string
          surface_condition?: string | null
          transaction_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          email: string
          full_name: string
          id: string
          username: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          email: string
          full_name?: string
          id: string
          username?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          email?: string
          full_name?: string
          id?: string
          username?: string | null
        }
        Relationships: []
      }
      security_audit_logs: {
        Row: {
          admin_id: string | null
          created_at: string
          description: string | null
          device_id: string | null
          event_id: string
          event_type: string
          ip_address: string | null
          request_id: string | null
          result: string | null
          user_id: string | null
        }
        Insert: {
          admin_id?: string | null
          created_at?: string
          description?: string | null
          device_id?: string | null
          event_id?: string
          event_type: string
          ip_address?: string | null
          request_id?: string | null
          result?: string | null
          user_id?: string | null
        }
        Update: {
          admin_id?: string | null
          created_at?: string
          description?: string | null
          device_id?: string | null
          event_id?: string
          event_type?: string
          ip_address?: string | null
          request_id?: string | null
          result?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_devices: {
        Row: {
          app_version: string | null
          approved_at: string | null
          approved_by: string | null
          browser: string | null
          browser_version: string | null
          created_at: string
          device_id: string
          device_name: string | null
          device_type: string | null
          first_seen_at: string
          id: string
          last_ip: string | null
          last_seen_at: string
          operating_system: string | null
          rejected_at: string | null
          revoked_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          approved_at?: string | null
          approved_by?: string | null
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          device_id: string
          device_name?: string | null
          device_type?: string | null
          first_seen_at?: string
          id?: string
          last_ip?: string | null
          last_seen_at?: string
          operating_system?: string | null
          rejected_at?: string | null
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          approved_at?: string | null
          approved_by?: string | null
          browser?: string | null
          browser_version?: string | null
          created_at?: string
          device_id?: string
          device_name?: string | null
          device_type?: string | null
          first_seen_at?: string
          id?: string
          last_ip?: string | null
          last_seen_at?: string
          operating_system?: string | null
          rejected_at?: string | null
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      next_beam_shard: { Args: never; Returns: number }
    }
    Enums: {
      app_role:
        | "admin"
        | "supervisor"
        | "loading_supervisor"
        | "dipping_supervisor"
        | "qc_inspector"
        | "shift_supervisor"
        | "manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "supervisor",
        "loading_supervisor",
        "dipping_supervisor",
        "qc_inspector",
        "shift_supervisor",
        "manager",
      ],
    },
  },
} as const

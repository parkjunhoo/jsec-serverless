import { createClient } from '@supabase/supabase-js';
import { handleLogin } from './api/users/login.js';
import { handleCreateUser } from './api/users/create.js';
import { handleDeleteUser } from './api/users/delete.js';
import { handleListUsers } from './api/users/list.js';
import { handleUpdateUser } from './api/users/update.js';
import {
  handleCreateVehicle,
  handleDeleteVehicle,
  handleUpdateVehicle
} from './api/vehicles.js';
import {
  handleCreateItemRequest,
  handleDeleteItemRequest,
  handleListItemRequests,
  handleReviewItemRequest
} from './api/item-requests.js';
import {
  handleCreateVacation,
  handleBulkCreateVacations,
  handleDeleteVacation,
  handleListVacations,
  handleUpdateVacation
} from './api/vacations.js';
import {
  handleDeleteCalendarNote,
  handleListCalendarNotes,
  handleSaveCalendarNote
} from './api/calendar-notes.js';
import { handleGetResortNotice, handleListResortNotices } from './api/resort-notices.js';
import {
  handleGetMealPlan,
  handleGetMealPlanImage,
  handleSaveMealPlan
} from './api/meal-plan.js';
import {
  handleCreateAnnualLeaveRequest,
  handleDeleteAnnualLeaveRequest,
  handleListAnnualLeaveRequests,
  handleReviewAnnualLeaveRequest
} from './api/annual-leave-requests.js';
import {
  handleGetAnnualLeave,
  handleUpdateAnnualLeaveSettings,
  handleUpdateEmployeeAnnualLeaveDeductions
} from './api/annual-leave.js';
import {
  handleAttendancePunch,
  handleCorrectAttendanceRecord,
  handleListAttendanceRecords,
  handleListAttendanceSites,
  handleSaveAttendanceSites
} from './api/attendance.js';
import {
  handleBroadcastPush,
  handleDeleteAllNotifications,
  handleDeleteNotification,
  handleGetPushPreference,
  handleListNotifications,
  handleMarkAllNotificationsRead,
  handleMarkNotificationRead,
  handleRegisterPushToken,
  handleSetPushPreference
} from './api/push.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 공통 CORS 헤더 (DELETE 허용 포함)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // 1. 브라우저 OPTIONS Preflight 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (
      url.pathname === '/api/allowances' ||
      url.pathname.startsWith('/api/allowances/') ||
      url.pathname === '/api/corporate-cards' ||
      url.pathname.startsWith('/api/corporate-cards/')
    ) {
      return new Response(JSON.stringify({ error: '이 기능은 현재 비활성화되어 있습니다.' }), {
        status: 410,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Supabase Admin 클라이언트 생성 (환경변수 검증)
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Supabase 환경 변수(URL 또는 SERVICE_ROLE_KEY)가 설정되지 않았습니다.');
      }

      const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

      // 2. 로그인 라우팅
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, supabaseAdmin);
      }

      // 3. 회원 생성 라우팅
      if (url.pathname === '/api/users/create' && request.method === 'POST') {
        return await handleCreateUser(request, supabaseAdmin);
      }

      // 4. 회원 목록 라우팅
      if (url.pathname === '/api/users/list' && request.method === 'GET') {
        return await handleListUsers(request, supabaseAdmin);
      }

      // 5. 회원 삭제 라우팅 (경로가 /api/users/delete/ 로 시작하고 DELETE 요청인 경우)
      if (url.pathname.startsWith('/api/users/delete/') && request.method === 'DELETE') {
        return await handleDeleteUser(request, supabaseAdmin);
      }

      if (url.pathname.startsWith('/api/users/') && request.method === 'PATCH') {
        const userId = url.pathname.slice('/api/users/'.length);
        return await handleUpdateUser(request, supabaseAdmin, userId);
      }

      if (url.pathname === '/api/vehicles' && request.method === 'POST') {
        return await handleCreateVehicle(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/vehicles/') && request.method === 'PATCH') {
        const vehicleId = decodeURIComponent(url.pathname.slice('/api/vehicles/'.length));
        return await handleUpdateVehicle(request, supabaseAdmin, vehicleId);
      }
      if (url.pathname.startsWith('/api/vehicles/') && request.method === 'DELETE') {
        const vehicleId = decodeURIComponent(url.pathname.slice('/api/vehicles/'.length));
        return await handleDeleteVehicle(request, supabaseAdmin, vehicleId);
      }

      if (url.pathname === '/api/item-requests' && request.method === 'GET') {
        return await handleListItemRequests(request, supabaseAdmin);
      }
      if (url.pathname === '/api/item-requests' && request.method === 'POST') {
        return await handleCreateItemRequest(request, supabaseAdmin, env, ctx);
      }
      if (url.pathname.startsWith('/api/item-requests/') && request.method === 'DELETE') {
        const requestId = url.pathname.slice('/api/item-requests/'.length);
        return await handleDeleteItemRequest(request, supabaseAdmin, requestId);
      }
      if (url.pathname.startsWith('/api/item-requests/') && request.method === 'PATCH') {
        const requestId = url.pathname.slice('/api/item-requests/'.length);
        return await handleReviewItemRequest(request, supabaseAdmin, requestId);
      }

      if (url.pathname === '/api/push/register' && request.method === 'POST') {
        return await handleRegisterPushToken(request, supabaseAdmin);
      }
      if (url.pathname === '/api/push/preference' && request.method === 'GET') {
        return await handleGetPushPreference(request, supabaseAdmin);
      }
      if (url.pathname === '/api/push/preference' && request.method === 'PUT') {
        return await handleSetPushPreference(request, supabaseAdmin);
      }
      if (url.pathname === '/api/push/broadcast' && request.method === 'POST') {
        return await handleBroadcastPush(request, supabaseAdmin, env);
      }
      if (url.pathname === '/api/notifications' && request.method === 'GET') {
        return await handleListNotifications(request, supabaseAdmin);
      }
      if (url.pathname === '/api/notifications' && request.method === 'DELETE') {
        return await handleDeleteAllNotifications(request, supabaseAdmin);
      }
      if (url.pathname === '/api/notifications/read-all' && request.method === 'PUT') {
        return await handleMarkAllNotificationsRead(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/notifications/') && request.method === 'PUT') {
        const notificationId = url.pathname.slice('/api/notifications/'.length);
        return await handleMarkNotificationRead(request, supabaseAdmin, notificationId);
      }
      if (url.pathname.startsWith('/api/notifications/') && request.method === 'DELETE') {
        const notificationId = url.pathname.slice('/api/notifications/'.length);
        return await handleDeleteNotification(request, supabaseAdmin, notificationId);
      }

      // 7. 휴무 관련 라우팅 분기
      if (url.pathname === '/api/vacations' && request.method === 'GET') {
        return await handleListVacations(request, supabaseAdmin);
      }
      if (url.pathname === '/api/annual-leave-requests' && request.method === 'GET') {
        return await handleListAnnualLeaveRequests(request, supabaseAdmin);
      }
      if (url.pathname === '/api/annual-leave' && request.method === 'GET') {
        return await handleGetAnnualLeave(request, supabaseAdmin);
      }
      if (url.pathname === '/api/annual-leave/settings' && request.method === 'PUT') {
        return await handleUpdateAnnualLeaveSettings(request, supabaseAdmin);
      }
      if (url.pathname === '/api/annual-leave/deductions' && request.method === 'PUT') {
        return await handleUpdateEmployeeAnnualLeaveDeductions(request, supabaseAdmin);
      }
      if (url.pathname === '/api/attendance/sites' && request.method === 'GET') {
        return await handleListAttendanceSites(request, supabaseAdmin);
      }
      if (url.pathname === '/api/attendance/sites' && request.method === 'PUT') {
        return await handleSaveAttendanceSites(request, supabaseAdmin);
      }
      if (url.pathname === '/api/attendance/records' && request.method === 'GET') {
        return await handleListAttendanceRecords(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/attendance/records/') && request.method === 'PATCH') {
        const recordId = decodeURIComponent(url.pathname.slice('/api/attendance/records/'.length));
        return await handleCorrectAttendanceRecord(request, supabaseAdmin, recordId);
      }
      if (url.pathname === '/api/attendance/check-in' && request.method === 'POST') {
        return await handleAttendancePunch(request, supabaseAdmin, 'check-in');
      }
      if (url.pathname === '/api/attendance/check-out' && request.method === 'POST') {
        return await handleAttendancePunch(request, supabaseAdmin, 'check-out');
      }
      if (url.pathname === '/api/annual-leave-requests' && request.method === 'POST') {
        return await handleCreateAnnualLeaveRequest(request, supabaseAdmin, env, ctx);
      }
      if (url.pathname.startsWith('/api/annual-leave-requests/') && request.method === 'DELETE') {
        const requestId = decodeURIComponent(url.pathname.slice('/api/annual-leave-requests/'.length));
        return await handleDeleteAnnualLeaveRequest(request, supabaseAdmin, requestId);
      }
      if (url.pathname.startsWith('/api/annual-leave-requests/') && request.method === 'PATCH') {
        const requestId = decodeURIComponent(url.pathname.slice('/api/annual-leave-requests/'.length));
        return await handleReviewAnnualLeaveRequest(request, supabaseAdmin, env, ctx, requestId);
      }
      if (url.pathname === '/api/resort-notices' && request.method === 'GET') {
        return await handleListResortNotices(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/resort-notices/') && request.method === 'GET') {
        const noticeId = url.pathname.slice('/api/resort-notices/'.length);
        return await handleGetResortNotice(request, supabaseAdmin, noticeId);
      }
      if (url.pathname === '/api/vacations/create' && request.method === 'POST') {
        return await handleCreateVacation(request, supabaseAdmin, env, ctx);
      }
      if (url.pathname === '/api/vacations/bulk' && request.method === 'POST') {
        return await handleBulkCreateVacations(request, supabaseAdmin, env, ctx);
      }
      if (url.pathname.startsWith('/api/vacations/delete/') && request.method === 'DELETE') {
        const vacationId = url.pathname.slice('/api/vacations/delete/'.length);
        return await handleDeleteVacation(request, supabaseAdmin, env, ctx, vacationId);
      }
      if (url.pathname.startsWith('/api/vacations/') && request.method === 'PATCH') {
        const vacationId = url.pathname.slice('/api/vacations/'.length);
        return await handleUpdateVacation(request, supabaseAdmin, env, ctx, vacationId);
      }

      if (url.pathname === '/api/calendar-notes' && request.method === 'GET') {
        return await handleListCalendarNotes(request, supabaseAdmin);
      }
      if (url.pathname === '/api/calendar-notes' && request.method === 'PUT') {
        return await handleSaveCalendarNote(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/calendar-notes/') && request.method === 'DELETE') {
        const date = url.pathname.slice('/api/calendar-notes/'.length);
        return await handleDeleteCalendarNote(request, supabaseAdmin, date);
      }

      if (url.pathname === '/api/meal-plan' && request.method === 'GET') {
        return await handleGetMealPlan(request, supabaseAdmin);
      }
      if (url.pathname === '/api/meal-plan' && request.method === 'POST') {
        return await handleSaveMealPlan(request, supabaseAdmin, env, ctx);
      }
      if (url.pathname === '/api/meal-plan/image' && request.method === 'GET') {
        return await handleGetMealPlanImage(request, supabaseAdmin, env);
      }

      // 8. 404 경로 처리
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      console.error('Worker Top-Level Error:', err);
      return new Response(JSON.stringify({ error: `Worker 치명적 오류: ${err.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
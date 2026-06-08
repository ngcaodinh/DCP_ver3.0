'use client';

import { useMemo, useState } from 'react';
import styles from './RegulatoryBodiesPageClient.module.css';
import { getMetricItemList, getUrgentRequestItemList } from './regulatoryBodiesData';

type PageKey = 'dashboard' | 'disbursement' | 'kyc' | 'report' | 'transparency';
type NavigationItem = { key: PageKey; label: string; badge?: number };

const navigationItemList: NavigationItem[] = [
  { key: 'dashboard', label: 'Tổng quan' },
  { key: 'disbursement', label: 'Ký duyệt Giải ngân', badge: 3 },
  { key: 'kyc', label: 'Duyệt Hồ sơ KYC', badge: 5 },
  { key: 'report', label: 'Báo cáo Tuân thủ' },
  { key: 'transparency', label: 'Tra cứu Giao dịch' }
];

const activityItemList = [
  { actionText: 'Ký duyệt yêu cầu', detailText: 'REQ-2026-028 · Nước sạch cho miền Tây', timeText: '2 phút trước' },
  { actionText: 'Xem hồ sơ KYC', detailText: 'ORG-55 · Quỹ Trẻ Em Việt Xanh', timeText: '15 phút trước' },
  { actionText: 'Đăng nhập hệ thống', detailText: 'Thiết bị Chrome · Hà Nội', timeText: '42 phút trước' }
];

const auditLogItemList = [
  { id: 'TX-91A3F2', requestText: 'REQ-2026-031', amountText: '450,000,000₫', statusText: 'Đã ký', actorText: 'Bộ Tài chính', timeText: '14:28:10' },
  { id: 'TX-83BC9D', requestText: 'REQ-2026-028', amountText: '320,000,000₫', statusText: 'Chờ ký', actorText: 'Tổ chức Hành Động Xanh', timeText: '13:55:47' },
  { id: 'TX-67AA20', requestText: 'REQ-2026-025', amountText: '150,000,000₫', statusText: 'Đã ký', actorText: 'Quỹ Nhân Ái Toàn Dân', timeText: '11:20:31' }
];

const disbursementQueueItemList = [
  { requestId: 'REQ-2026-031', projectName: 'Mái ấm vùng cao Lào Cai', amountText: '450,000,000₫', signatureText: '1/3', stateText: 'Khẩn' },
  { requestId: 'REQ-2026-028', projectName: 'Nước sạch cho miền Tây', amountText: '320,000,000₫', signatureText: '2/3', stateText: 'Đang xử lý' },
  { requestId: 'REQ-2026-025', projectName: 'Xe cứu thương cộng đồng', amountText: '150,000,000₫', signatureText: '2/3', stateText: 'Sẵn sàng chuyển khoản' }
];

const kycSubmissionItemList = [
  { organizationName: 'Quỹ Trẻ Em Việt Xanh', versionText: 'v3', submittedAtText: '22/03/2026 13:20', stateText: 'Chờ duyệt' },
  { organizationName: 'Tổ chức Hành Động Xanh', versionText: 'v2', submittedAtText: '22/03/2026 10:05', stateText: 'Cần bổ sung' },
  { organizationName: 'Quỹ Nhân Ái Toàn Dân', versionText: 'v1', submittedAtText: '21/03/2026 17:45', stateText: 'Đã duyệt' }
];

const transparencyTransactionItemList = [
  { transactionId: 'TX-91A3F2', requestId: 'REQ-2026-031', transactionType: 'Disbursement', amountText: '450,000,000₫', timeText: '14:28:10' },
  { transactionId: 'TX-83BC9D', requestId: 'REQ-2026-028', transactionType: 'Disbursement', amountText: '320,000,000₫', timeText: '13:55:47' },
  { transactionId: 'TX-12CE70', requestId: 'DON-2026-119', transactionType: 'Donation', amountText: '25,000,000₫', timeText: '13:12:26' }
];

/** Hàm chuẩn hóa tiêu đề trang theo menu đang chọn để đồng bộ breadcrumb và header. */
function getPageTitle(pageKey: PageKey): string {
  if (pageKey === 'dashboard') return 'Tổng quan Giám sát';
  if (pageKey === 'disbursement') return 'Ký duyệt Giải ngân';
  if (pageKey === 'kyc') return 'Duyệt Hồ sơ KYC';
  if (pageKey === 'report') return 'Báo cáo Tuân thủ';
  return 'Tra cứu Giao dịch';
}

/** Hàm trả về class hạn xử lý để tô màu mức độ ưu tiên trong bảng yêu cầu gấp. */
function getDeadlineClassName(deadlineClassName: string): string {
  if (deadlineClassName === 'urgent') return styles.deadlineUrgent;
  if (deadlineClassName === 'normal') return styles.deadlineNormal;
  return styles.deadlineOk;
}

/** Hàm trả về class màu card metric theo biến thể dữ liệu từ nguồn fake data. */
function getMetricToneClassName(metricColorVariant: string): string {
  if (metricColorVariant === 'amber') return styles.amber;
  if (metricColorVariant === 'cyan') return styles.cyan;
  if (metricColorVariant === 'green') return styles.green;
  return styles.navy;
}

/** Hàm trả về class badge trạng thái để dùng lại cho nhiều bảng khác nhau. */
function getStateBadgeClassName(stateText: string): string {
  if (stateText === 'Đã duyệt' || stateText === 'Sẵn sàng chuyển khoản' || stateText === 'Đã ký') return styles.statusDone;
  if (stateText === 'Cần bổ sung' || stateText === 'Khẩn' || stateText === 'Đang xử lý' || stateText === 'Chờ ký' || stateText === 'Chờ duyệt') return styles.statusPending;
  return styles.stateBadgeNeutral;
}

/** Hàm render nội dung theo tab để tránh lặp code và giữ luồng hiển thị rõ ràng. */
function renderNonDashboardPanel(selectedPageKey: PageKey) {
  if (selectedPageKey === 'disbursement') {
    return (
      <div className={styles.panelCard}>
        <h2 className={styles.panelTitle}>Hàng chờ ký duyệt giải ngân</h2>
        <table className={styles.tableElement}>
          <thead>
            <tr>
              <th>Mã yêu cầu</th>
              <th>Dự án</th>
              <th>Số tiền</th>
              <th>Chữ ký</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {disbursementQueueItemList.map(disbursementQueueItem => (
              <tr key={disbursementQueueItem.requestId}>
                <td className={styles.auditHash}>{disbursementQueueItem.requestId}</td>
                <td>{disbursementQueueItem.projectName}</td>
                <td>{disbursementQueueItem.amountText}</td>
                <td>{disbursementQueueItem.signatureText}</td>
                <td>
                  <span className={getStateBadgeClassName(disbursementQueueItem.stateText)}>{disbursementQueueItem.stateText}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (selectedPageKey === 'kyc') {
    return (
      <div className={styles.panelCard}>
        <h2 className={styles.panelTitle}>Danh sách hồ sơ KYC cần kiểm tra</h2>
        <table className={styles.tableElement}>
          <thead>
            <tr>
              <th>Tổ chức</th>
              <th>Phiên bản</th>
              <th>Thời gian nộp</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {kycSubmissionItemList.map(kycSubmissionItem => (
              <tr key={`${kycSubmissionItem.organizationName}-${kycSubmissionItem.versionText}`}>
                <td>{kycSubmissionItem.organizationName}</td>
                <td>{kycSubmissionItem.versionText}</td>
                <td>{kycSubmissionItem.submittedAtText}</td>
                <td>
                  <span className={getStateBadgeClassName(kycSubmissionItem.stateText)}>{kycSubmissionItem.stateText}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (selectedPageKey === 'report') {
    return (
      <div className={styles.panelCard}>
        <h2 className={styles.panelTitle}>Báo cáo tuân thủ</h2>
        <ul className={styles.activityList}>
          <li className={styles.activityItem}>
            <p className={styles.activityAction}>Tỷ lệ ký duyệt đúng hạn: 92%</p>
            <p className={styles.activityDetail}>So với tuần trước: tăng 5%</p>
          </li>
          <li className={styles.activityItem}>
            <p className={styles.activityAction}>Hồ sơ KYC hoàn tất: 37 hồ sơ</p>
            <p className={styles.activityDetail}>Trong đó 4 hồ sơ yêu cầu bổ sung</p>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div className={styles.panelCard}>
      <h2 className={styles.panelTitle}>Tra cứu giao dịch minh bạch</h2>
      <table className={styles.tableElement}>
        <thead>
          <tr>
            <th>Tx hash</th>
            <th>Mã nghiệp vụ</th>
            <th>Loại</th>
            <th>Số tiền</th>
            <th>Thời gian</th>
          </tr>
        </thead>
        <tbody>
          {transparencyTransactionItemList.map(transparencyTransactionItem => (
            <tr key={transparencyTransactionItem.transactionId}>
              <td className={styles.auditHash}>{transparencyTransactionItem.transactionId}</td>
              <td>{transparencyTransactionItem.requestId}</td>
              <td>{transparencyTransactionItem.transactionType}</td>
              <td>{transparencyTransactionItem.amountText}</td>
              <td>{transparencyTransactionItem.timeText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hàm render trang Cơ quan giám sát theo JSX thuần để bám sát giao diện mẫu HTML gốc. */
export default function RegulatoryBodiesPageClient() {
  const [selectedPageKey, setSelectedPageKey] = useState<PageKey>('dashboard');
  const metricItemList = useMemo(() => getMetricItemList(), []);
  const urgentRequestItemList = useMemo(() => getUrgentRequestItemList(), []);

  return (
    <main className={styles.pageRoot}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarLogoSection}>
          <div className={styles.logoIcon}>
            <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.inlineIcon}>
              <path d="M12 21s-6.7-4.2-9.2-8.2C.5 9.3 2 5.2 5.8 4.2c2-.5 4 .2 5.2 1.8 1.2-1.6 3.2-2.3 5.2-1.8 3.8 1 5.3 5.1 3 8.6C18.7 16.8 12 21 12 21z" fill="currentColor" />
            </svg>
          </div>
          <div>
            <p className={styles.logoText}>DCP</p>
            <p className={styles.logoSubText}>Decentralized Charity Platform</p>
          </div>
        </div>

        <div className={styles.portalBadge}>Cổng Cơ quan Giám sát</div>

        <p className={styles.navigationTitle}>Điều hướng chính</p>
        <nav className={styles.navigationContainer}>
          {navigationItemList.map(navigationItem => (
            <button
              key={navigationItem.key}
              type="button"
              className={`${styles.navigationItem} ${selectedPageKey === navigationItem.key ? styles.navigationItemActive : ''}`}
              onClick={() => setSelectedPageKey(navigationItem.key)}
            >
              <span>{navigationItem.label}</span>
              {navigationItem.badge ? <span className={styles.navigationBadge}>{navigationItem.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.avatarBadge}>BTC</div>
          <div>
            <p className={styles.footerName}>Bộ Tài chính</p>
            <p className={styles.footerRole}>Cơ quan giám sát</p>
          </div>
        </div>
      </aside>

      <div className={styles.mainWrap}>
        <header className={styles.topbarContainer}>
          <p className={styles.breadcrumbText}>
            DCP › {selectedPageKey === 'dashboard' ? 'Tổng quan' : getPageTitle(selectedPageKey)}
          </p>

          <div className={styles.topbarRightContainer}>
            <button type="button" className={styles.topbarIconButton}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.inlineIcon}>
                <path d="M12 3a5 5 0 0 0-5 5v2.9c0 .8-.3 1.6-.8 2.3L5 15h14l-1.2-1.8a4 4 0 0 1-.8-2.3V8a5 5 0 0 0-5-5z" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="M9.5 18a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <span className={styles.notificationBadge}>5</span>
            </button>
            <div className={styles.topbarUserContainer}>
              <span className={styles.topbarUserAvatar}>BTC</span>
              <span>Bộ Tài chính</span>
            </div>
            <button type="button" className={styles.logoutButton}>Đăng xuất</button>
          </div>
        </header>

        <section className={styles.contentContainer}>
          <div className={styles.pageHeader}>
            <h1 className={styles.pageTitleText}>{getPageTitle(selectedPageKey)}</h1>
            <p className={styles.pageSubText}>Thứ Sáu, 22/03/2026 — Cập nhật lúc 14:32</p>
          </div>

          {selectedPageKey === 'dashboard' ? (
            <>
              <div className={styles.metricsGrid}>
                {metricItemList.map(metricItem => (
                  <article key={metricItem.label} className={`${styles.metricCard} ${getMetricToneClassName(metricItem.colorVariant)}`}>
                    <p className={styles.metricValue}>{metricItem.value}</p>
                    <p className={styles.metricLabel}>{metricItem.label}</p>
                    <p className={styles.metricTrend}>{metricItem.trendText}</p>
                  </article>
                ))}
              </div>

              <div className={styles.twoColumnLayout}>
                <div className={styles.panelCard}>
                  <h2 className={styles.panelTitle}>⚡ Yêu cầu cần xử lý gấp</h2>
                  <table className={styles.tableElement}>
                    <thead>
                      <tr>
                        <th>Dự án / Tổ chức</th>
                        <th>Số tiền</th>
                        <th>Chữ ký</th>
                        <th>Hết hạn</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {urgentRequestItemList.map(urgentRequestItem => (
                        <tr key={urgentRequestItem.id}>
                          <td>
                            <p className={styles.projectNameText}>{urgentRequestItem.projectName}</p>
                            <p className={styles.projectOrganizationText}>{urgentRequestItem.organizationName}</p>
                          </td>
                          <td className={styles.amountText}>{urgentRequestItem.amountText}</td>
                          <td className={styles.signatureText}>{urgentRequestItem.signatureState}</td>
                          <td>
                            <span className={`${styles.countdownTag} ${getDeadlineClassName(urgentRequestItem.deadlineClassName)}`}>
                              {urgentRequestItem.deadlineText}
                            </span>
                          </td>
                          <td>
                            <button type="button" className={styles.actionButton}>Xem & Ký</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className={styles.panelStack}>
                  <div className={styles.panelCard}>
                    <h2 className={styles.panelTitle}>Tình trạng giải ngân tháng 3</h2>
                    <div className={styles.donutWrap}>
                      <div className={styles.donutContainer}>
                        <svg viewBox="0 0 120 120" className={styles.donutChart} aria-hidden="true">
                          <circle cx="60" cy="60" r="48" className={styles.donutTrack} />
                          <circle cx="60" cy="60" r="48" className={styles.donutSegmentDone} />
                          <circle cx="60" cy="60" r="48" className={styles.donutSegmentProcessing} />
                          <circle cx="60" cy="60" r="48" className={styles.donutSegmentPending} />
                        </svg>
                        <div className={styles.donutCenterText}>72%</div>
                      </div>
                      <div className={styles.donutLegendList}>
                        <p><span className={styles.legendDotDone} />Đã hoàn tất: 72%</p>
                        <p><span className={styles.legendDotProcessing} />Đang xử lý: 20%</p>
                        <p><span className={styles.legendDotPending} />Chờ xác nhận: 8%</p>
                      </div>
                    </div>
                  </div>
                  <div className={styles.panelCard}>
                    <h2 className={styles.panelTitle}>Hoạt động gần đây</h2>
                    <ul className={styles.activityList}>
                      {activityItemList.map(activityItem => (
                        <li key={activityItem.detailText} className={styles.activityItem}>
                          <p className={styles.activityAction}>{activityItem.actionText}</p>
                          <p className={styles.activityDetail}>{activityItem.detailText}</p>
                          <p className={styles.activityTime}>{activityItem.timeText}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <div className={styles.auditCard}>
                <div className={styles.auditCardHeader}>
                  <h2 className={styles.panelTitle}>Nhật ký ký duyệt gần nhất</h2>
                  <button type="button" className={styles.exportButton}>Xuất báo cáo</button>
                </div>
                <table className={styles.auditTable}>
                  <thead>
                    <tr>
                      <th>Tx hash</th>
                      <th>Yêu cầu</th>
                      <th>Số tiền</th>
                      <th>Trạng thái</th>
                      <th>Đơn vị thao tác</th>
                      <th>Thời gian</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogItemList.map(auditLogItem => (
                      <tr key={auditLogItem.id}>
                        <td className={styles.auditHash}>{auditLogItem.id}</td>
                        <td>{auditLogItem.requestText}</td>
                        <td>{auditLogItem.amountText}</td>
                        <td>
                          <span className={getStateBadgeClassName(auditLogItem.statusText)}>{auditLogItem.statusText}</span>
                        </td>
                        <td>{auditLogItem.actorText}</td>
                        <td>{auditLogItem.timeText}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            renderNonDashboardPanel(selectedPageKey)
          )}
        </section>
      </div>
    </main>
  );
}


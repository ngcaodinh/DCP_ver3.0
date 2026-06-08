// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DcpCharityToken} from "./DcpCharityToken.sol";
import {DcpDonationRanking} from "./DcpDonationRanking.sol";

/**
 * @title MultisigDisbursement
 * @notice Hop dong giai ngan da chu ky tu 3 vai tro: Admin he thong,
 *         Dai dien to chuc tu thien, Co quan giam sat.
 *         Chinh sach chu ky dong theo requestMode va ty le raised/goal.
 *         Chi rut duoc 80% tong raised, timeout 7 ngay, evidence bat buoc.
 *         Tuong tac voi DcpCharityToken (burn token) va DcpDonationRanking (doc so du).
 */
contract MultisigDisbursement is AccessControl, Pausable, ReentrancyGuard {

    // ============ ROLES ============
    bytes32 public constant ADMIN_SIGNER_ROLE     = keccak256("ADMIN_SIGNER_ROLE");
    bytes32 public constant ORG_SIGNER_ROLE       = keccak256("ORG_SIGNER_ROLE");
    bytes32 public constant REGULATORY_SIGNER_ROLE = keccak256("REGULATORY_SIGNER_ROLE");

    // ============ CONSTANTS ============
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10000;
    uint256 public constant MIN_NORMAL_RAISED_BPS    = 2000; // 20%
    uint256 public constant FAST_TRACK_RAISED_BPS    = 5000; // 50%
    uint256 public constant APPROVALS_TWO_OF_THREE   = 2;
    uint256 public constant APPROVALS_THREE_OF_THREE = 3;
    uint256 public constant WITHDRAWAL_RESERVE_BPS = 2000; // 20% reserve -> max 80% withdrawal
    uint256 public constant TIMEOUT_SECONDS        = 7 days;
    uint256 public constant MIN_SIGNERS_PER_ROLE   = 1;

    // ============ STATE ============
    uint256 private _nextRequestId;

    /// @notice Dem so luong signer cho moi role — phuc vu kiem tra khong duoc revoke neu con 1 signer.
    mapping(bytes32 role => uint256 signerCount) private _roleSignerCount;

    struct DisbursementRequest {
        bool exists;
        uint256 requestId;
        uint256 projectId;
        address beneficiaryAddress;
        uint256 amount;
        RequestMode requestMode;
        uint256 requiredApprovals;
        uint256 raisedRatioBpsAtCreation;
        string evidenceCid;           // IPFS CID cua bang chung su dung tien
        RequestStatus status;
        uint256 approvalCount;
        mapping(address => bool) hasSigned;
        bool adminRoleSigned;
        bool orgRoleSigned;
        bool regulatoryRoleSigned;
        address[3] signedSigners;     // Chi luu 3 signer dau tien (dung voi 1 signer moi role)
        uint256 signedCount;
        uint256 createdAt;
        uint256 executedAt;
        uint256 cancelledAt;
        string rejectReason;
        address creatorAddress;        // Dia chi tai khoan tao request — dung de kiem tra org khong tu reject
        uint256 timeoutDeadline;       // Thoi diem timeout cua request
    }

    enum RequestStatus {
        None,
        Pending,
        Approved,
        Executing,
        Completed,
        Rejected,
        Cancelled,
        Expired
    }

    enum RequestMode {
        Normal,
        Emergency
    }

    /// @notice Struct tra ve cac truong value types cua yeu cau.
    struct RequestData {
        bool exists;
        uint256 requestId;
        uint256 projectId;
        address beneficiaryAddress;
        uint256 amount;
        uint8 status;
        uint256 approvalCount;
        uint256 signedCount;
        uint256 createdAt;
        uint256 executedAt;
        uint256 cancelledAt;
        bool adminSigned;
        bool orgSigned;
        bool regulatorySigned;
        uint256 timeoutDeadline;
        uint256 maxWithdrawable;
        uint8 requestMode;
        uint256 requiredApprovals;
        uint256 raisedRatioBpsAtCreation;
        bool adminRoleSignatureCollected;
        bool orgRoleSignatureCollected;
        bool regulatoryRoleSignatureCollected;
    }

    struct RequestStrings {
        string evidenceCid;
        string rejectReason;
    }

    mapping(uint256 => DisbursementRequest) private requests;
    mapping(address => uint256) private pendingRequestsByBeneficiary;
    mapping(uint256 => uint256) private pendingRequestsByProject;

    DcpCharityToken    public immutable charityToken;
    DcpDonationRanking public immutable donationRanking;

    // ============ ERRORS ============
    error InvalidAddress();
    error InvalidProjectId();
    error InvalidProjectGoalAmount();
    error InvalidAmount();
    error RequestNotFound();
    error InvalidRequestState();
    error MaxWithdrawalExceeded(uint256 requested, uint256 maxAllowed);
    error MinimumRaisedNotMet();
    error NormalModeRequiresEmergency();
    error InvalidRequestMode();
    error EmergencyReasonRequired();
    error EvidenceRequired();
    error AlreadySigned();
    error RoleAlreadySigned();
    error InvalidSignerRole();
    error InsufficientSignatures();
    error RequestNotExpired();
    error DuplicateBeneficiaryPending();
    error DuplicateProjectPending();
    error SelfCancellationForbidden();
    error SignerAlreadyExists();
    error SignerNotFound();
    error SigningSlotsExceeded();

    // ============ EVENTS ============
    event RequestCreated(
        uint256 indexed requestId,
        uint256 indexed projectId,
        address indexed beneficiary,
        uint256 amount,
        string evidenceCid,
        uint256 createdAt,
        uint256 timeoutDeadline,
        uint8 requestMode,
        uint256 requiredApprovals,
        uint256 raisedRatioBpsAtCreation
    );
    event RequestStatusChanged(
        uint256 indexed requestId,
        RequestStatus previousStatus,
        RequestStatus newStatus,
        string reason
    );
    event RequestSigned(
        uint256 indexed requestId,
        address indexed signer,
        bytes32 indexed signerRole
    );
    event ThresholdSignaturesReached(
        uint256 indexed requestId,
        uint256 indexed projectId,
        uint256 amount,
        address beneficiary,
        uint256 reachedAt
    );
    event DisbursementExecuted(
        uint256 indexed requestId,
        uint256 indexed projectId,
        uint256 amount,
        address beneficiary,
        uint256 transactionId,
        uint256 burnedAt
    );
    event RolePermissionUpdated(
        bytes32 indexed role,
        address indexed account,
        bool isGranted
    );
    event RequestTimeoutExtended(
        uint256 indexed requestId,
        uint256 newTimeoutDeadline,
        address extendedBy
    );

    /**
     * @notice Khoi tao hop dong, gan cac vai tro admin ban dau.
     * @param tokenAddress Dia chi DcpCharityToken.
     * @param rankingAddress Dia chi DcpDonationRanking.
     * @param adminSigner Tai khoan admin ky duyet.
     * @param orgSigner Dai dien to chuc tu thien.
     * @param regulatorySigner Co quan giam sat.
     */
    constructor(
        address tokenAddress,
        address rankingAddress,
        address adminSigner,
        address orgSigner,
        address regulatorySigner
    ) {
        if (tokenAddress == address(0) || rankingAddress == address(0) ||
            adminSigner == address(0) || orgSigner == address(0) || regulatorySigner == address(0))
            revert InvalidAddress();

        charityToken    = DcpCharityToken(tokenAddress);
        donationRanking = DcpDonationRanking(rankingAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_SIGNER_ROLE,       adminSigner);
        _grantRole(ORG_SIGNER_ROLE,         orgSigner);
        _grantRole(REGULATORY_SIGNER_ROLE,  regulatorySigner);

        _roleSignerCount[ADMIN_SIGNER_ROLE]      = 1;
        _roleSignerCount[ORG_SIGNER_ROLE]        = 1;
        _roleSignerCount[REGULATORY_SIGNER_ROLE]  = 1;

        _nextRequestId = 1;

        emit RolePermissionUpdated(ADMIN_SIGNER_ROLE,      adminSigner,      true);
        emit RolePermissionUpdated(ORG_SIGNER_ROLE,        orgSigner,        true);
        emit RolePermissionUpdated(REGULATORY_SIGNER_ROLE,  regulatorySigner, true);
    }

    // ============ EXTERNAL FUNCTIONS — CORE BUSINESS ============

    /**
     * @notice To chuc tu thien tao yeu cau rut tien.
     *         Kiem tra: amount <= 80% raised, evidence khong trong, khong co request dang pending.
     * @param projectId ID du an tren blockchain.
     * @param beneficiary Dia chi nhan tien (tai khoan to chuc).
     * @param amount So token muon rut.
     * @param projectGoalAmount Muc tieu cua du an (tu MongoDB) de kiem tra 50% goal.
     * @param evidenceCid CID IPFS cua bang chung su dung tien.
     * @param requestMode Che do tao request: 0 = Normal, 1 = Emergency.
     * @param emergencyReason Ly do khan cap, bat buoc khi requestMode la Emergency.
     * @return requestId Ma yeu cau giai ngan.
     */
    function createDisbursementRequest(
        uint256 projectId,
        address beneficiary,
        uint256 amount,
        uint256 projectGoalAmount,
        string calldata evidenceCid,
        uint8 requestMode,
        string calldata emergencyReason
    ) external onlyRole(ORG_SIGNER_ROLE) nonReentrant whenNotPaused returns (uint256 requestId) {
        if (projectId == 0) revert InvalidProjectId();
        if (beneficiary == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (projectGoalAmount == 0) revert InvalidProjectGoalAmount();
        if (bytes(evidenceCid).length == 0) revert EvidenceRequired();
        if (requestMode > uint8(RequestMode.Emergency)) revert InvalidRequestMode();

        RequestMode resolvedMode = RequestMode(requestMode);
        if (resolvedMode == RequestMode.Emergency && bytes(emergencyReason).length == 0) {
            revert EmergencyReasonRequired();
        }

        // Kiem tra khong co request pending cua cung beneficiary.
        uint256 existingBeneficiary = pendingRequestsByBeneficiary[beneficiary];
        if (existingBeneficiary != 0 && requests[existingBeneficiary].status == RequestStatus.Pending) {
            revert DuplicateBeneficiaryPending();
        }

        // Kiem tra du an chua co request pending nao.
        uint256 existingProject = pendingRequestsByProject[projectId];
        if (existingProject != 0 && requests[existingProject].status == RequestStatus.Pending) {
            revert DuplicateProjectPending();
        }

        // Lay snapshot va kiem tra du an ton tai.
        DcpDonationRanking.ProjectSnapshot memory snapshot = donationRanking.getProjectSnapshot(projectId);
        if (!snapshot.exists) revert MinimumRaisedNotMet();

        uint256 raisedRatioBpsAtCreation = _calculateRaisedRatioBps(
            snapshot.totalDonationAmount,
            projectGoalAmount
        );
        uint256 requiredApprovals = _resolveRequiredApprovals(
            resolvedMode,
            raisedRatioBpsAtCreation
        );

        // Tinh max withdrawable: 80% cua totalRaised.
        uint256 maxBase =
            (snapshot.totalDonationAmount * (BASIS_POINTS_DENOMINATOR - WITHDRAWAL_RESERVE_BPS)) /
            BASIS_POINTS_DENOMINATOR;
        if (amount > maxBase) revert MaxWithdrawalExceeded(amount, maxBase);

        // Tao request moi.
        uint256 newRequestId = _nextRequestId++;
        DisbursementRequest storage req = requests[newRequestId];
        req.exists              = true;
        req.requestId           = newRequestId;
        req.projectId           = projectId;
        req.beneficiaryAddress  = beneficiary;
        req.amount              = amount;
        req.requestMode         = resolvedMode;
        req.requiredApprovals   = requiredApprovals;
        req.raisedRatioBpsAtCreation = raisedRatioBpsAtCreation;
        req.evidenceCid         = evidenceCid;
        req.status              = RequestStatus.Pending;
        req.approvalCount       = 0;
        req.signedCount         = 0;
        req.createdAt           = block.timestamp;
        req.timeoutDeadline     = block.timestamp + TIMEOUT_SECONDS;
        req.creatorAddress      = msg.sender;

        pendingRequestsByBeneficiary[beneficiary] = newRequestId;
        pendingRequestsByProject[projectId]       = newRequestId;

        emit RequestCreated(
            newRequestId,
            projectId,
            beneficiary,
            amount,
            evidenceCid,
            block.timestamp,
            req.timeoutDeadline,
            uint8(resolvedMode),
            requiredApprovals,
            raisedRatioBpsAtCreation
        );
        emit RequestStatusChanged(newRequestId, RequestStatus.None, RequestStatus.Pending, "");

        return newRequestId;
    }

    /**
     * @notice Ky duyet yeu cau giai ngan.
     *         Kiem tra: request dang Pending, signer co dung vai tro, chua ky, chua timeout.
     *         Khi du chu ky theo nguong dong cua request -> tu dong chuyen sang Approved.
     * @param requestId Ma yeu cau giai ngan.
     */
    function signRequest(uint256 requestId) external nonReentrant whenNotPaused {
        if (!requests[requestId].exists) revert RequestNotFound();

        DisbursementRequest storage req = requests[requestId];
        if (req.status != RequestStatus.Pending) revert InvalidRequestState();

        // Kiem tra request co bi timeout chua.
        if (block.timestamp > req.timeoutDeadline) {
            pendingRequestsByBeneficiary[req.beneficiaryAddress] = 0;
            pendingRequestsByProject[req.projectId] = 0;
            _transitionToStatus(requestId, RequestStatus.Expired, "Timeout 7 days");
            revert RequestNotExpired();
        }

        // Xac dinh vai tro cua signer.
        bytes32 signerRole;
        if (hasRole(ADMIN_SIGNER_ROLE, msg.sender)) {
            signerRole = ADMIN_SIGNER_ROLE;
        } else if (hasRole(ORG_SIGNER_ROLE, msg.sender)) {
            signerRole = ORG_SIGNER_ROLE;
        } else if (hasRole(REGULATORY_SIGNER_ROLE, msg.sender)) {
            signerRole = REGULATORY_SIGNER_ROLE;
        } else {
            revert InvalidSignerRole();
        }

        if (req.hasSigned[msg.sender]) revert AlreadySigned();
        if (_isRoleAlreadySigned(req, signerRole)) revert RoleAlreadySigned();

        // Safety check: moi request toi da 3 chu ky tu 3 vai tro khac nhau.
        if (req.signedCount >= 3) revert SigningSlotsExceeded();

        // Danh dau signer da ky.
        req.hasSigned[msg.sender]          = true;
        _markRoleAsSigned(req, signerRole);
        req.signedSigners[req.signedCount] = msg.sender;
        req.signedCount++;
        req.approvalCount++;

        emit RequestSigned(requestId, msg.sender, signerRole);

        // Kiem tra da du chu ky theo chinh sach cua request hay chua.
        if (_hasMinimumApprovals(requestId)) {
            _transitionToStatus(requestId, RequestStatus.Approved, "Required signatures collected");
            emit ThresholdSignaturesReached(
                requestId,
                req.projectId,
                req.amount,
                req.beneficiaryAddress,
                block.timestamp
            );
        }
    }

    /**
     * @notice Tu choi yeu cau giai ngan. Khong cho phep org tu tu choi request cua chinh minh.
     * @param requestId Ma yeu cau.
     * @param reason Ly do tu choi (toi thieu 5 ky tu).
     */
    function rejectRequest(uint256 requestId, string calldata reason) external nonReentrant whenNotPaused {
        if (!requests[requestId].exists) revert RequestNotFound();

        DisbursementRequest storage req = requests[requestId];
        if (req.status != RequestStatus.Pending) revert InvalidRequestState();

        // Kiem tra timeout truoc khi cho phep reject.
        if (block.timestamp > req.timeoutDeadline) {
            pendingRequestsByBeneficiary[req.beneficiaryAddress] = 0;
            pendingRequestsByProject[req.projectId] = 0;
            _transitionToStatus(requestId, RequestStatus.Expired, "Timeout 7 days");
            revert RequestNotExpired();
        }

        // Xac thuc signer co vai tro hop le.
        bytes32 signerRole;
        bool hasValidRole = false;
        if (hasRole(ADMIN_SIGNER_ROLE, msg.sender)) {
            signerRole = ADMIN_SIGNER_ROLE;
            hasValidRole = true;
        } else if (hasRole(ORG_SIGNER_ROLE, msg.sender)) {
            signerRole = ORG_SIGNER_ROLE;
            hasValidRole = true;
        } else if (hasRole(REGULATORY_SIGNER_ROLE, msg.sender)) {
            signerRole = REGULATORY_SIGNER_ROLE;
            hasValidRole = true;
        }
        if (!hasValidRole) revert InvalidSignerRole();

        // Chan org signer tu reject request cua chinh minh.
        if (signerRole == ORG_SIGNER_ROLE) {
            if (msg.sender == req.creatorAddress) revert SelfCancellationForbidden();
        }

        if (bytes(reason).length < 5) revert InvalidAmount();

        pendingRequestsByBeneficiary[req.beneficiaryAddress] = 0;
        pendingRequestsByProject[req.projectId] = 0;
        req.rejectReason = reason;
        _transitionToStatus(requestId, RequestStatus.Rejected, reason);
    }

    /**
     * @notice Backend goi sau khi PayOS chuyen khoan thanh cong.
     *         Burn token truc tiep tu DcpDonationRanking thong qua DcpCharityToken.burnForDisbursement.
     *         Idempotency: cung requestId tra ve cung ket qua, khong bi double-burn.
     *         Chi goi duoc khi request dang Approved.
     * @param requestId Ma yeu cau giai ngan (dung lam requestCode cho idempotency).
     * @param transactionId ID giao dich PayOS de audit.
     * @return burnedAmount So token da burn.
     */
    function finalizeDisbursement(uint256 requestId, uint256 transactionId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 burnedAmount)
    {
        if (!requests[requestId].exists) revert RequestNotFound();

        DisbursementRequest storage req = requests[requestId];
        if (req.status != RequestStatus.Approved) revert InvalidRequestState();

        pendingRequestsByBeneficiary[req.beneficiaryAddress] = 0;
        pendingRequestsByProject[req.projectId] = 0;
        req.executedAt = block.timestamp;

        // Chuyen requestId sang string lam requestCode cho idempotency tren DcpCharityToken.
        // _toString(requestId) tra ve chuoi nhu "1", "2", "123" — deterministic va doc ngu.
        // keccak256(abi.encode(requestCode)) ben trong burnForDisbursement dam bao moi requestId co
        // ma idempotency rieng biet, ngan chan double-burn khi replay.
        string memory requestCode = _toString(requestId);

        // Burn truc tiep tu DcpDonationRanking — MultisigDisbursement can DISBURSEMENT_ROLE
        // duoc grant tren DcpCharityToken sau khi deploy.
        charityToken.burnForDisbursement(
            address(donationRanking), // nguon chua token (DcpDonationRanking luu token tu donate())
            req.amount,              // so luong burn
            requestCode              // idempotency key
        );

        _transitionToStatus(requestId, RequestStatus.Completed, "");

        emit DisbursementExecuted(
            requestId,
            req.projectId,
            req.amount,
            req.beneficiaryAddress,
            transactionId,
            block.timestamp
        );

        return req.amount;
    }

    /**
     * @notice Huy request dang pending (chi admin duoc phep).
     *         Dung cho truong hop xu ly ngoai le thu cong.
     * @param requestId Ma yeu cau.
     * @param reason Ly do huy.
     */
    function cancelRequestByAdmin(uint256 requestId, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (!requests[requestId].exists) revert RequestNotFound();

        DisbursementRequest storage req = requests[requestId];
        if (req.status != RequestStatus.Pending) revert InvalidRequestState();

        pendingRequestsByBeneficiary[req.beneficiaryAddress] = 0;
        pendingRequestsByProject[req.projectId] = 0;
        req.rejectReason = reason;
        req.cancelledAt = block.timestamp;
        _transitionToStatus(requestId, RequestStatus.Cancelled, reason);
    }

    /**
     * @notice Gia han timeout cho request (chi DEFAULT_ADMIN_ROLE).
     *         Dung khi can them thoi gian de thu thap chu ky.
     * @param requestId Ma yeu cau.
     * @param additionalSeconds So giay them vao.
     */
    function extendRequestTimeout(uint256 requestId, uint256 additionalSeconds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (!requests[requestId].exists) revert RequestNotFound();
        DisbursementRequest storage req = requests[requestId];
        if (req.status != RequestStatus.Pending) revert InvalidRequestState();

        uint256 newDeadline = req.timeoutDeadline + additionalSeconds;
        req.timeoutDeadline = newDeadline;

        emit RequestTimeoutExtended(requestId, newDeadline, msg.sender);
    }

    // ============ PAUSE FUNCTIONS ============
    /** @notice Tam dung hop dong khi phat hien rui ro bao mat. */
    function pauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }

    /** @notice Mo lai hop dong sau khi xu ly xong su co. */
    function unpauseContract() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ============ ROLE MANAGEMENT ============

    /** @notice Cap quyen ky cho tai khoan admin signer. */
    function grantAdminSignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (hasRole(ADMIN_SIGNER_ROLE, account)) revert SignerAlreadyExists();
        _grantRole(ADMIN_SIGNER_ROLE, account);
        _roleSignerCount[ADMIN_SIGNER_ROLE]++;
        emit RolePermissionUpdated(ADMIN_SIGNER_ROLE, account, true);
    }

    /** @notice Cap quyen ky cho tai khoan org signer. */
    function grantOrgSignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (hasRole(ORG_SIGNER_ROLE, account)) revert SignerAlreadyExists();
        _grantRole(ORG_SIGNER_ROLE, account);
        _roleSignerCount[ORG_SIGNER_ROLE]++;
        emit RolePermissionUpdated(ORG_SIGNER_ROLE, account, true);
    }

    /** @notice Cap quyen ky cho tai khoan regulatory signer. */
    function grantRegulatorySignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (hasRole(REGULATORY_SIGNER_ROLE, account)) revert SignerAlreadyExists();
        _grantRole(REGULATORY_SIGNER_ROLE, account);
        _roleSignerCount[REGULATORY_SIGNER_ROLE]++;
        emit RolePermissionUpdated(REGULATORY_SIGNER_ROLE, account, true);
    }

    /** @notice Thu hoi quyen ky. Khong cho phep revoke neu so signer se < 1. */
    function revokeAdminSignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (!hasRole(ADMIN_SIGNER_ROLE, account)) revert SignerNotFound();
        if (_roleSignerCount[ADMIN_SIGNER_ROLE] <= MIN_SIGNERS_PER_ROLE) revert InsufficientSignatures();
        _revokeRole(ADMIN_SIGNER_ROLE, account);
        _roleSignerCount[ADMIN_SIGNER_ROLE]--;
        emit RolePermissionUpdated(ADMIN_SIGNER_ROLE, account, false);
    }

    /** @notice Thu hoi quyen ky org. */
    function revokeOrgSignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (!hasRole(ORG_SIGNER_ROLE, account)) revert SignerNotFound();
        if (_roleSignerCount[ORG_SIGNER_ROLE] <= MIN_SIGNERS_PER_ROLE) revert InsufficientSignatures();
        _revokeRole(ORG_SIGNER_ROLE, account);
        _roleSignerCount[ORG_SIGNER_ROLE]--;
        emit RolePermissionUpdated(ORG_SIGNER_ROLE, account, false);
    }

    /** @notice Thu hoi quyen ky regulatory. */
    function revokeRegulatorySignerRole(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        if (!hasRole(REGULATORY_SIGNER_ROLE, account)) revert SignerNotFound();
        if (_roleSignerCount[REGULATORY_SIGNER_ROLE] <= MIN_SIGNERS_PER_ROLE) revert InsufficientSignatures();
        _revokeRole(REGULATORY_SIGNER_ROLE, account);
        _roleSignerCount[REGULATORY_SIGNER_ROLE]--;
        emit RolePermissionUpdated(REGULATORY_SIGNER_ROLE, account, false);
    }

    /** @notice Tra ve so luong signer hien tai cua mot vai tro. */
    function getRoleSignerCount(bytes32 role) external view returns (uint256) {
        return _roleSignerCount[role];
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Tra thong tin dac diem (value types) cua yeu cau giai ngan.
     * @param requestId Ma yeu cau.
     * @return data Struct RequestData chua cac truong value types.
     */
    function getRequest(uint256 requestId) external view returns (RequestData memory data) {
        DisbursementRequest storage req = requests[requestId];
        if (!req.exists) {
            data.exists = false;
            return data;
        }

        data.exists              = true;
        data.requestId          = req.requestId;
        data.projectId          = req.projectId;
        data.beneficiaryAddress = req.beneficiaryAddress;
        data.amount             = req.amount;
        data.status             = uint8(req.status);
        data.approvalCount     = req.approvalCount;
        data.signedCount        = req.signedCount;
        data.createdAt          = req.createdAt;
        data.executedAt         = req.executedAt;
        data.cancelledAt        = req.cancelledAt;
        data.adminSigned        = hasRole(ADMIN_SIGNER_ROLE, msg.sender) ? req.hasSigned[msg.sender] : false;
        data.orgSigned          = hasRole(ORG_SIGNER_ROLE, msg.sender) ? req.hasSigned[msg.sender] : false;
        data.regulatorySigned   = hasRole(REGULATORY_SIGNER_ROLE, msg.sender) ? req.hasSigned[msg.sender] : false;
        data.timeoutDeadline    = req.timeoutDeadline;
        data.requestMode        = uint8(req.requestMode);
        data.requiredApprovals  = req.requiredApprovals;
        data.raisedRatioBpsAtCreation = req.raisedRatioBpsAtCreation;
        data.adminRoleSignatureCollected = req.adminRoleSigned;
        data.orgRoleSignatureCollected = req.orgRoleSigned;
        data.regulatoryRoleSignatureCollected = req.regulatoryRoleSigned;

        // Tinh maxWithdrawable hien tai (tru pending requests).
        uint256 totalRaised = donationRanking.getProjectSnapshot(req.projectId).totalDonationAmount;
        uint256 maxBase =
            (totalRaised * (BASIS_POINTS_DENOMINATOR - WITHDRAWAL_RESERVE_BPS)) /
            BASIS_POINTS_DENOMINATOR;
        data.maxWithdrawable = maxBase;
    }

    /**
     * @notice Tra cac truong string (evidence CID, reject reason) cua yeu cau.
     * @param requestId Ma yeu cau.
     * @return strings Struct RequestStrings chua cac truong string.
     */
    function getRequestStrings(uint256 requestId) external view returns (RequestStrings memory strings) {
        DisbursementRequest storage req = requests[requestId];
        if (!req.exists) return strings;
        strings.evidenceCid   = req.evidenceCid;
        strings.rejectReason = req.rejectReason;
    }

    /**
     * @notice Kiem tra signer da ky request chua.
     * @param requestId Ma yeu cau.
     * @param signer Dia chi signer can kiem tra.
     * @return signed True neu signer da ky.
     */
    function hasSigned(uint256 requestId, address signer) external view returns (bool) {
        if (!requests[requestId].exists) return false;
        return requests[requestId].hasSigned[signer];
    }

    /**
     * @notice Tra so du kha dung toi da cho withdrawal cua mot du an.
     *         Da tru di cac pending requests cua du an do.
     * @param projectId ID du an.
     * @return maxAmount So token toi da co the rut.
     */
    function getMaxWithdrawableAmount(uint256 projectId) external view returns (uint256 maxAmount) {
        DcpDonationRanking.ProjectSnapshot memory snapshot = donationRanking.getProjectSnapshot(projectId);
        if (!snapshot.exists) return 0;
        uint256 totalRaised = snapshot.totalDonationAmount;
        if (totalRaised == 0) return 0;

        uint256 maxBase = (totalRaised * (10000 - WITHDRAWAL_RESERVE_BPS)) / 10000;

        // Tru di amount cua pending request hien tai (neu co).
        uint256 pendingId = pendingRequestsByProject[projectId];
        if (pendingId != 0 && requests[pendingId].status == RequestStatus.Pending) {
            uint256 pendingAmount = requests[pendingId].amount;
            if (pendingAmount >= maxBase) return 0;
            return maxBase - pendingAmount;
        }

        return maxBase;
    }

    /**
     * @notice Kiem tra trang thai timeout cua mot request.
     * @param requestId Ma yeu cau.
     * @return expired True neu da timeout.
     */
    function isRequestExpired(uint256 requestId) external view returns (bool expired) {
        if (!requests[requestId].exists) return false;
        return requests[requestId].status == RequestStatus.Pending &&
               block.timestamp > requests[requestId].timeoutDeadline;
    }

    // ============ INTERNAL FUNCTIONS ============

    /**
     * @notice Kiểm tra đã đủ chữ ký theo ngưỡng động của request hay chưa.
     * @param requestId Mã yêu cầu.
     * @return True nếu số vai trò đã ký >= requiredApprovals.
     */
    function _hasMinimumApprovals(uint256 requestId) internal view returns (bool) {
        DisbursementRequest storage req = requests[requestId];
        uint256 roleCount = (req.adminRoleSigned ? 1 : 0) +
            (req.orgRoleSigned ? 1 : 0) +
            (req.regulatoryRoleSigned ? 1 : 0);
        return roleCount >= req.requiredApprovals;
    }

    /**
     * @notice Tính tỷ lệ raised/goal tại thời điểm tạo request theo đơn vị basis points.
     * @param totalRaisedAmount Tổng số tiền đã raised của dự án.
     * @param projectGoalAmount Mục tiêu gọi vốn của dự án.
     * @return raisedRatioBps Tỷ lệ raised/goal * 10_000.
     */
    function _calculateRaisedRatioBps(
        uint256 totalRaisedAmount,
        uint256 projectGoalAmount
    ) internal pure returns (uint256 raisedRatioBps) {
        if (projectGoalAmount == 0) revert InvalidProjectGoalAmount();
        return (totalRaisedAmount * BASIS_POINTS_DENOMINATOR) / projectGoalAmount;
    }

    /**
     * @notice Xác định số chữ ký bắt buộc theo requestMode và tỷ lệ raised/goal.
     * @param requestModeValue Chế độ request (Normal/Emergency).
     * @param raisedRatioBps Tỷ lệ raised/goal tại thời điểm tạo request.
     * @return requiredApprovals Ngưỡng chữ ký cần đạt cho request.
     */
    function _resolveRequiredApprovals(
        RequestMode requestModeValue,
        uint256 raisedRatioBps
    ) internal pure returns (uint256 requiredApprovals) {
        if (requestModeValue == RequestMode.Emergency) {
            return APPROVALS_THREE_OF_THREE;
        }

        if (requestModeValue != RequestMode.Normal) revert InvalidRequestMode();

        if (raisedRatioBps < MIN_NORMAL_RAISED_BPS) {
            revert NormalModeRequiresEmergency();
        }

        if (raisedRatioBps >= FAST_TRACK_RAISED_BPS) {
            return APPROVALS_TWO_OF_THREE;
        }

        return APPROVALS_THREE_OF_THREE;
    }

    /**
     * @notice Kiểm tra vai trò ký hiện tại đã được dùng trong request hay chưa.
     * @param req Bản ghi request đang xử lý.
     * @param signerRole Vai trò của signer hiện tại.
     * @return True nếu vai trò đó đã ký trước đó.
     */
    function _isRoleAlreadySigned(
        DisbursementRequest storage req,
        bytes32 signerRole
    ) internal view returns (bool) {
        if (signerRole == ADMIN_SIGNER_ROLE) return req.adminRoleSigned;
        if (signerRole == ORG_SIGNER_ROLE) return req.orgRoleSigned;
        if (signerRole == REGULATORY_SIGNER_ROLE) return req.regulatoryRoleSigned;
        return false;
    }

    /**
     * @notice Đánh dấu vai trò đã ký để đảm bảo mỗi vai trò chỉ ký một lần.
     * @param req Bản ghi request đang xử lý.
     * @param signerRole Vai trò của signer hiện tại.
     */
    function _markRoleAsSigned(DisbursementRequest storage req, bytes32 signerRole) internal {
        if (signerRole == ADMIN_SIGNER_ROLE) {
            req.adminRoleSigned = true;
            return;
        }
        if (signerRole == ORG_SIGNER_ROLE) {
            req.orgRoleSigned = true;
            return;
        }
        if (signerRole == REGULATORY_SIGNER_ROLE) {
            req.regulatoryRoleSigned = true;
            return;
        }

        revert InvalidSignerRole();
    }

    /**
     * @notice Chuyen trang thai request va ghi log su kien.
     * @param requestId Ma yeu cau.
     * @param newStatus Trang thai moi.
     * @param reason Ly do chuyen trang thai.
     */
    function _transitionToStatus(
        uint256 requestId,
        RequestStatus newStatus,
        string memory reason
    ) internal {
        RequestStatus previousStatus = requests[requestId].status;
        requests[requestId].status = newStatus;
        emit RequestStatusChanged(requestId, previousStatus, newStatus, reason);
    }

    /**
     * @notice Tra ve dia chi nguoi tao request.
     * @param requestId Ma yeu cau.
     * @return Dia chi nguoi tao.
     */
    function _getOriginalCreator(uint256 requestId) internal view returns (address) {
        return requests[requestId].creatorAddress;
    }

    /**
     * @notice Chuyen uint256 thanh string — dung lam requestCode cho idempotency.
     *         Khong su dung Strings.toString vi yeu cau solc ^0.8.24.
     * @param value Gia tri can chuyen.
     * @return result Chuoi dai dien.
     */
    function _toString(uint256 value) internal pure returns (string memory result) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
